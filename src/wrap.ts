import path from "node:path";
import process from "node:process";

import { spawn, type IPty } from "node-pty";

import type { TrrConfig } from "./config";
import { loadConfig, resolveStorePath, writeDefaultConfig } from "./config";
import { adapterForHost, type HostAdapter } from "./host-adapters";
import { ensureShimDirectory, findRealExecutable, resolveExecInvocation } from "./shim-common";
import { TaskRecoveryRuntime } from "./runtime";
import { normalizeWhitespace, sha256 } from "./utils";
import { captureWorkspaceSnapshot } from "./workspace";
import { installClaudeHooks, type ClaudeHookInstallResult } from "./claude-hooks";
import { codexHomeDir, installCodexHooks, type CodexHookInstallResult } from "./codex-hooks";

export interface WrapHostOptions {
  host: string;
  workspaceRoot?: string;
  config?: TrrConfig;
  dbPath?: string;
  passthroughArgs?: string[];
  stdio?: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    error?: NodeJS.WritableStream;
  };
  autoExitOnChildExit?: boolean;
}

export interface WrapHostResult {
  sessionId: string;
  exitCode: number;
  restartCount: number;
  resumed: boolean;
}

const RESUME_PACKET_BEGIN = "[TRR_RESUME_PACKET_BEGIN";
const RESUME_PACKET_END = "[TRR_RESUME_PACKET_END]";
const RESUME_INJECTION_COOLDOWN_MS = 1200;

interface ResumeEchoFilterState {
  pending: string;
  suppressing: boolean;
}

interface HostBootstrapResult {
  configPath: string;
  claudeHooks?: ClaudeHookInstallResult;
  codexHooks?: CodexHookInstallResult;
}

function trailingPartialMarkerLength(source: string, marker: string): number {
  const maxLength = Math.min(source.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (source.endsWith(marker.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function commandFromConfig(host: string, config: TrrConfig, passthroughArgs: string[]): { command: string; args: string[] } {
  if (host === "generic-pty") {
    if (passthroughArgs.length === 0) {
      throw new Error("generic-pty requires a command after --");
    }
    return {
      command: passthroughArgs[0]!,
      args: passthroughArgs.slice(1)
    };
  }

  const profile = config.hostProfiles[host as keyof TrrConfig["hostProfiles"]];
  const command = profile?.command;
  if (!command) {
    throw new Error(`no command configured for host ${host}`);
  }

  return {
    command,
    args: [...(profile?.args ?? []), ...passthroughArgs]
  };
}

function cmdShellArgument(value: string): string {
  if (!value) return '""';
  if (!/[\s"&<>|^()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '""').replace(/%/g, "%%")}"`;
}

function resolvePtyCommand(
  command: string,
  args: string[]
): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args };
  }

  const needsShell = !(/[\\/]/.test(command) || path.isAbsolute(command)) || /\.(cmd|bat)$/i.test(command);
  if (!needsShell) {
    return { command, args };
  }

  const commandLine = [command, ...args].map(cmdShellArgument).join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", commandLine]
  };
}

function hostEnv(
  config: TrrConfig,
  sessionId: string,
  host: string,
  shimDir: string,
  restartCount: number,
  storePath: string
): Record<string, string> {
  const execInvocation = resolveExecInvocation();
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    ),
    PATH: [shimDir, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
    TRR_SESSION_ID: sessionId,
    TRR_HOST: host,
    TRR_WORKSPACE_ROOT: config.workspaceRoot,
    TRR_STORE_PATH: storePath,
    TRR_AUTO_RESTART_COUNT: String(restartCount),
    TRR_GUARD_POLICY_JSON: JSON.stringify(config.guardPolicy),
    TRR_NODE_EXECUTABLE: execInvocation.executable,
    TRR_EXEC_ENTRY: execInvocation.args[0] || ""
  };
}

function eofSequenceForHostInput(): string {
  return process.platform === "win32" ? "\u001a\r" : "\u0004";
}

function recordHostLine(
  runtime: TaskRecoveryRuntime,
  sessionId: string,
  adapter: HostAdapter,
  line: string
): void {
  const normalized = normalizeWhitespace(line);
  if (!normalized) return;

  const planHints = adapter.extractPlanHints(normalized);
  if (planHints && (planHints.nextAction || planHints.items?.length)) {
    runtime.recordEvent({
      sessionId,
      kind: "plan_update",
      payload: {
        items: planHints.items ?? [],
        ...(planHints.nextAction ? { nextAction: planHints.nextAction } : {})
      }
    });
  }

  const toolHints = adapter.extractToolHints(normalized);
  if (toolHints?.command || toolHints?.toolName) {
    runtime.recordEvent({
      sessionId,
      kind: toolHints.command ? "command_exec" : "tool_call",
      payload: {
        ...(toolHints.command ? { command: toolHints.command } : {}),
        ...(toolHints.toolName ? { toolName: toolHints.toolName } : {}),
        ...(toolHints.summary ? { summary: toolHints.summary } : {}),
        sideEffect: toolHints.sideEffect === true
      }
    });
  }

  const shouldPersistHostLine =
    adapter.detectSessionStart(normalized) ||
    adapter.detectCompaction(normalized).matched ||
    adapter.detectNeedResume(normalized).matched ||
    Boolean(planHints?.nextAction || planHints?.items?.length) ||
    Boolean(toolHints?.command || toolHints?.toolName) ||
    /\b(error|warn|failed|exception|blocked)\b/i.test(normalized);

  if (!shouldPersistHostLine) {
    return;
  }

  runtime.recordEvent({
    sessionId,
    kind: "host_event",
    payload: {
      text: normalized,
      host: adapter.id
    }
  });
}

function stripInjectedResumeEcho(
  state: ResumeEchoFilterState,
  chunk: string
): string {
  const combined = state.pending + chunk;
  state.pending = "";

  let index = 0;
  let visible = "";
  while (index < combined.length) {
    if (state.suppressing) {
      const endIndex = combined.indexOf(RESUME_PACKET_END, index);
      if (endIndex === -1) {
        const pendingLength = trailingPartialMarkerLength(combined.slice(index), RESUME_PACKET_END);
        const safeCut = combined.length - pendingLength;
        state.pending = combined.slice(safeCut);
        return visible;
      }
      index = endIndex + RESUME_PACKET_END.length;
      state.suppressing = false;
      continue;
    }

    const beginIndex = combined.indexOf(RESUME_PACKET_BEGIN, index);
    if (beginIndex === -1) {
      const pendingLength = trailingPartialMarkerLength(combined.slice(index), RESUME_PACKET_BEGIN);
      const safeCut = combined.length - pendingLength;
      visible += combined.slice(index, safeCut);
      state.pending = combined.slice(safeCut);
      return visible;
    }

    visible += combined.slice(index, beginIndex);
    index = beginIndex + RESUME_PACKET_BEGIN.length;
    state.suppressing = true;
  }

  return visible;
}

function flushResumeEchoFilter(state: ResumeEchoFilterState): string {
  if (state.suppressing) {
    state.pending = "";
    return "";
  }
  const tail = state.pending;
  state.pending = "";
  return tail;
}

function injectResume(
  runtime: TaskRecoveryRuntime,
  sessionId: string,
  adapter: HostAdapter,
  pty: IPty,
  reason: string
): boolean {
  runtime.createCheckpoint(sessionId, true);
  const packet = runtime.buildResumePacket(sessionId).packet;
  const envelope = adapter.buildResumeEnvelope(packet);
  const packetHash = sha256(envelope);
  if (runtime.latestResumePacketHash(sessionId) === packetHash) {
    return false;
  }

  runtime.recordEvent({
    sessionId,
    kind: "resume_started",
    payload: { reason, host: adapter.id }
  });
  pty.write(`${envelope}\r`);
  runtime.recordEvent({
    sessionId,
    kind: "resume_injected",
    payload: {
      reason,
      packetHash,
      host: adapter.id
    }
  });
  runtime.recordEvent({
    sessionId,
    kind: "resume_finished",
    payload: { reason, host: adapter.id }
  });
  return true;
}

function ensureHostBootstrap(host: string, workspaceRoot: string): HostBootstrapResult {
  const configPath = writeDefaultConfig(workspaceRoot);
  if (host === "claude") {
    return {
      configPath,
      claudeHooks: installClaudeHooks(workspaceRoot)
    };
  }
  if (host === "codex") {
    return {
      configPath,
      codexHooks: installCodexHooks(codexHomeDir())
    };
  }
  return { configPath };
}

export async function wrapHost(options: WrapHostOptions): Promise<WrapHostResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  const bootstrap = ensureHostBootstrap(options.host, workspaceRoot);
  const config = options.config || loadConfig(workspaceRoot);
  const dbPath = options.dbPath || resolveStorePath(config);
  const runtime = new TaskRecoveryRuntime({ dbPath });
  const adapter = adapterForHost(
    options.host,
    config.hostProfiles[options.host as keyof TrrConfig["hostProfiles"]]
  );
  const shimDir = ensureShimDirectory(config.workspaceRoot, config.guardPolicy);
  const commandSpec = commandFromConfig(options.host, config, options.passthroughArgs ?? []);
  const launchCommand = {
    command: findRealExecutable(commandSpec.command, process.env.PATH || "", shimDir) || commandSpec.command,
    args: commandSpec.args
  };
  const ptyCommand = resolvePtyCommand(launchCommand.command, launchCommand.args);
  const output = options.stdio?.output || process.stdout;
  const error = options.stdio?.error || process.stderr;
  const input = options.stdio?.input || process.stdin;

  const existingSession =
    config.resumePolicy.resumeLatestOnStart
      ? runtime.findLatestSession({ host: options.host, workspaceRoot: config.workspaceRoot })
      : undefined;
  const session =
    existingSession ??
    runtime.createSession({
      provider: "custom",
      model: config.hostProfiles[options.host as keyof TrrConfig["hostProfiles"]]?.model || options.host,
      host: options.host,
      workspaceRoot: config.workspaceRoot
    });

  runtime.recordEvent({
    sessionId: session.id,
    kind: "host_event",
    payload: {
      host: options.host,
      bootstrap: {
        configPath: bootstrap.configPath,
        ...(bootstrap.claudeHooks
          ? {
              claudeHooks: {
                settingsPath: bootstrap.claudeHooks.settingsPath,
                command: bootstrap.claudeHooks.command,
                changed: bootstrap.claudeHooks.changed
              }
            }
          : {}),
        ...(bootstrap.codexHooks
          ? {
              codexHooks: {
                codexHome: bootstrap.codexHooks.codexHome,
                configPath: bootstrap.codexHooks.configPath,
                hooksPath: bootstrap.codexHooks.hooksPath,
                command: bootstrap.codexHooks.command,
                changed: bootstrap.codexHooks.changed,
                featureFlagEnabled: bootstrap.codexHooks.featureFlagEnabled
              }
            }
          : {}),
      },
      command: commandSpec.command,
      args: commandSpec.args
    }
  });
  runtime.recordWorkspaceSnapshot(session.id, captureWorkspaceSnapshot(config.workspaceRoot));

  let exitCode = 0;
  let restartCount = 0;
  let resumed = false;

  const launch = async (): Promise<number> => {
    const pty = spawn(ptyCommand.command, ptyCommand.args, {
      name: "xterm-color",
      cols: 120,
      rows: 36,
      cwd: config.workspaceRoot,
      env: hostEnv(config, session.id, options.host, shimDir, restartCount, dbPath)
    });

    let initialResumeScheduled = Boolean(existingSession && runtime.getLatestCheckpoint(session.id));
    let injectedOnce = false;
    let lastResumeInjectedAt = 0;
    let lineBuffer = "";
    const filterState: ResumeEchoFilterState = {
      pending: "",
      suppressing: false
    };

    const maybeInjectResume = (reason: string): boolean => {
      if (Date.now() - lastResumeInjectedAt < RESUME_INJECTION_COOLDOWN_MS) {
        return false;
      }
      const didInject = injectResume(runtime, session.id, adapter, pty, reason);
      if (didInject) {
        lastResumeInjectedAt = Date.now();
        injectedOnce = true;
        resumed = true;
      }
      return didInject;
    };

    const onInput = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      pty.write(text);
      for (const line of text.split(/\r?\n/).map((item) => normalizeWhitespace(item)).filter(Boolean)) {
        runtime.recordEvent({
          sessionId: session.id,
          kind: "user_message",
          payload: {
            text: line,
            host: options.host
          }
        });
      }
    };

    const onInputEnd = () => {
      if ("isTTY" in input && input.isTTY) {
        return;
      }
      pty.write(eofSequenceForHostInput());
    };

    input.resume();
    input.on("data", onInput);
    input.on("end", onInputEnd);

    const cleanupInput = () => {
      input.pause();
      input.removeListener("data", onInput);
      input.removeListener("end", onInputEnd);
    };

    pty.onData((chunk) => {
      const visibleChunk = stripInjectedResumeEcho(filterState, chunk);
      if (!visibleChunk) {
        return;
      }

      output.write(visibleChunk);
      lineBuffer += visibleChunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        recordHostLine(runtime, session.id, adapter, line);
      }

      if (!injectedOnce && initialResumeScheduled && adapter.detectSessionStart(visibleChunk)) {
        maybeInjectResume("startup_resume");
      }

      const compaction = adapter.detectCompaction(visibleChunk);
      if (compaction.matched) {
        runtime.recordEvent({
          sessionId: session.id,
          kind: "compaction_detected",
          payload: {
            host: adapter.id,
            ...(compaction.reason ? { reason: compaction.reason } : {})
          }
        });
        if (config.resumePolicy.injectOnCompaction) {
          maybeInjectResume("compaction_detected");
        }
      }

      const needResume = adapter.detectNeedResume(visibleChunk);
      if (needResume.matched) {
        maybeInjectResume("host_requested_resume");
      }
    });

    return await new Promise<number>((resolve) => {
      const timer = initialResumeScheduled
        ? setTimeout(() => {
            if (!injectedOnce) {
              maybeInjectResume("startup_fallback");
            }
          }, 400)
        : undefined;

      pty.onExit(({ exitCode: code }) => {
        if (timer) clearTimeout(timer);
        cleanupInput();
        const trailingOutput = flushResumeEchoFilter(filterState);
        if (trailingOutput) {
          output.write(trailingOutput);
          lineBuffer += trailingOutput;
        }
        if (lineBuffer.trim()) {
          recordHostLine(runtime, session.id, adapter, lineBuffer);
        }
        runtime.recordWorkspaceSnapshot(session.id, captureWorkspaceSnapshot(config.workspaceRoot));
        runtime.createCheckpoint(session.id, true);
        resolve(code);
      });
    });
  };

  do {
    exitCode = await launch();
    if (
      exitCode !== 0 &&
      config.resumePolicy.restartOnCrash &&
      restartCount < config.resumePolicy.maxAutoRestarts
    ) {
      restartCount += 1;
      runtime.recordEvent({
        sessionId: session.id,
        kind: "process_restarted",
        payload: {
          reason: `exit_code=${exitCode}`,
          restartCount,
          host: options.host
        }
      });
      error.write(`\n[trr] host exited with code ${exitCode}; restarting with recovery...\n`);
    } else {
      break;
    }
  } while (true);

  runtime.close();
  if (options.autoExitOnChildExit !== false && exitCode !== 0) {
    process.exitCode = exitCode;
  }
  return {
    sessionId: session.id,
    exitCode,
    restartCount,
    resumed
  };
}
