#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { Command } from "commander";

import { AnthropicAdapter } from "./adapters/anthropic";
import { OpenAIAdapter } from "./adapters/openai";
import {
  codexHookInstallState,
  codexHomeDir,
  handleCodexHook,
  installCodexHooks
} from "./codex-hooks";
import {
  loadConfig,
  resolveStorePath,
  resolveWorkspaceRoot,
  writeDefaultConfig,
  type TrrConfig
} from "./config";
import { loadTraceCorpus } from "./evals/corpus";
import { loadEvalDataset } from "./evals/dataset";
import { renderEvalMarkdown, renderTraceCorpusEvalMarkdown } from "./evals/report";
import { runEval } from "./evals/runner";
import { handleClaudeHook, installClaudeHooks } from "./claude-hooks";
import { adapterForHost } from "./host-adapters";
import {
  harvestLocalTraces,
  normalizeClaudeSession,
  normalizeCodexArchivedSession
} from "./host-importers";
import { renderLiveReplayMarkdown, runLiveReplay } from "./live-eval";
import { TaskRecoveryRuntime } from "./runtime";
import { resolveFeedbackSession, writeFeedbackBundle } from "./feedback";
import {
  defaultRcFilePath,
  detectShellName,
  ensureShellIntegrationScript,
  installShellIntegration,
  isShellIntegrationInstalled,
  renderShellActivation,
  resolveShellLauncher
} from "./shell-integration";
import { ensureShimDirectory, findRealExecutable } from "./shim-common";
import { importTrace, loadTraceFile, traceToEvalDataset } from "./traces";
import { sha256 } from "./utils";
import { captureWorkspaceSnapshot } from "./workspace";
import type { JsonObject, ProposedAction } from "./types";

const TRR_VERSION = "0.1.2";

function parseJsonFile(path: string): JsonObject {
  return JSON.parse(fs.readFileSync(path, "utf8")) as JsonObject;
}

function parseInlineJson(value?: string): JsonObject | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as JsonObject;
}

function parseCsvList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function maybeRespawnForPty(workspaceRoot: string): void {
  if (process.env.TRR_PTY_RESPAWN === "1") {
    return;
  }

  const launcher = resolveShellLauncher(workspaceRoot);
  if (!launcher.ptyReady) {
    throw new Error(
      `unable to find a Node runtime with node-pty support for workspace ${workspaceRoot}; run trr doctor`
    );
  }

  const sameExecutable = path.resolve(launcher.nodeExecutable) === path.resolve(process.execPath);
  const sameEntry = path.resolve(launcher.cliEntry) === path.resolve(process.argv[1] || launcher.cliEntry);
  if (sameExecutable && sameEntry) {
    return;
  }

  const result = spawnSync(launcher.nodeExecutable, [launcher.cliEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      TRR_PTY_RESPAWN: "1"
    }
  });
  process.exitCode = result.status ?? 1;
  process.exit();
}

const program = new Command();
program.name("trr").description("任务恢复运行时 CLI").version(TRR_VERSION);

const DEFAULT_DB_PATH = ".tmp/trr-store.json";

program.option("--db <path>", "local store file path", DEFAULT_DB_PATH);

function effectiveDbPath(workspaceRoot = resolveWorkspaceRoot()): string {
  const explicit = program.opts().db as string;
  if (explicit && explicit !== DEFAULT_DB_PATH) return explicit;
  return resolveStorePath(loadConfig(workspaceRoot));
}

program
  .command("session")
  .description("会话相关命令")
  .addCommand(
    new Command("create")
      .requiredOption("--provider <provider>", "openai | anthropic | custom")
      .requiredOption("--model <model>", "model id")
      .option("--host <host>", "host id")
      .option("--workspace <path>", "workspace root")
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath(options.workspace) });
        const session = runtime.createSession({
          provider: options.provider,
          model: options.model,
          host: options.host,
          workspaceRoot: options.workspace
        });
        runtime.close();
        console.log(JSON.stringify(session, null, 2));
      })
  )
  .addCommand(
    new Command("list").action(() => {
      const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
      console.log(JSON.stringify(runtime.listSessions(), null, 2));
      runtime.close();
    })
  );

program
  .command("event")
  .description("事件相关命令")
  .addCommand(
    new Command("add")
      .requiredOption("--session <session>", "session id")
      .requiredOption("--kind <kind>", "event kind")
      .option("--text <text>", "text payload helper")
      .option("--payload-json <json>", "inline payload JSON")
      .option("--payload-file <path>", "payload JSON file")
      .option("--span-id <span>", "span id")
      .option("--parent-span-id <span>", "parent span id")
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
        const filePayload = options.payloadFile ? parseJsonFile(options.payloadFile) : undefined;
        const inlinePayload = parseInlineJson(options.payloadJson);
        const payload = {
          ...(filePayload ?? {}),
          ...(inlinePayload ?? {}),
          ...(options.text ? { text: options.text } : {})
        };
        const event = runtime.recordEvent({
          sessionId: options.session,
          kind: options.kind,
          payload,
          spanId: options.spanId,
          parentSpanId: options.parentSpanId
        });
        runtime.close();
        console.log(JSON.stringify(event, null, 2));
      })
  )
  .addCommand(
    new Command("list")
      .requiredOption("--session <session>", "session id")
      .option("--from <seq>", "from seq")
      .option("--to <seq>", "to seq")
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
        const events = runtime.listEvents(options.session, {
          fromSeq: options.from ? Number(options.from) : undefined,
          toSeq: options.to ? Number(options.to) : undefined
        });
        runtime.close();
        console.log(JSON.stringify(events, null, 2));
      })
  );

program
  .command("checkpoint")
  .description("checkpoint 相关命令")
  .addCommand(
    new Command("create")
      .requiredOption("--session <session>", "session id")
      .option("--force", "force checkpoint even if pending activity", false)
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
        const checkpoint = runtime.createCheckpoint(options.session, options.force);
        runtime.close();
        console.log(JSON.stringify(checkpoint, null, 2));
      })
  )
  .addCommand(
    new Command("show")
      .requiredOption("--session <session>", "session id")
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
        const checkpoint = runtime.getLatestCheckpoint(options.session);
        runtime.close();
        console.log(JSON.stringify(checkpoint, null, 2));
      })
  );

const resumeCommand = program
  .command("resume")
  .description("恢复包相关命令")
  .argument("[session]", "session id for manual resume injection/printing")
  .option("--host <host>", "resume envelope host", "generic-pty")
  .action((sessionId, options) => {
    if (!sessionId) {
      if (process.argv.includes("build")) return;
      throw new Error("session id is required or use `trr resume build`");
    }
    const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
    runtime.createCheckpoint(sessionId, true);
    const packet = runtime.buildResumePacket(sessionId);
    const config = loadConfig();
    const adapter = adapterForHost(
      options.host,
      config.hostProfiles[options.host as keyof TrrConfig["hostProfiles"]]
    );
    const envelope = adapter.buildResumeEnvelope(packet.packet);
    const packetHash = sha256(envelope);
    runtime.recordEvent({
      sessionId,
      kind: "resume_started",
      payload: { reason: "manual_resume", host: options.host }
    });
    runtime.recordEvent({
      sessionId,
      kind: "resume_injected",
      payload: { reason: "manual_resume", host: options.host, packetHash }
    });
    runtime.recordEvent({
      sessionId,
      kind: "resume_finished",
      payload: { reason: "manual_resume", host: options.host }
    });
    runtime.close();
    console.log(envelope);
  });

resumeCommand
  .addCommand(
    new Command("build")
      .requiredOption("--session <session>", "session id")
      .option("--exclude-latest-user", "exclude the latest user message", false)
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
        const packet = runtime.buildResumePacket(options.session, {
          excludeLatestUser: options.excludeLatestUser
        });
        runtime.close();
        console.log(packet.packet);
      })
  );

program
  .command("export-feedback")
  .description("导出当前或指定会话的脱敏反馈包")
  .argument("[session]", "session id；省略时导出当前工作区最新会话")
  .option("--last", "显式导出当前工作区最新会话", false)
  .option("--host <host>", "按 host 过滤最新会话，例如 codex 或 claude")
  .option("--out <path>", "输出文件路径，默认写入 .trr/feedback/")
  .option("--event-limit <n>", "时间线最多保留多少条事件", "80")
  .option("--artifact-limit <n>", "最多保留多少条最近 artifact", "20")
  .option("--checkpoint-limit <n>", "最多保留多少个 checkpoint 预览", "5")
  .option("--label <label>", "人工结果标签，例如 success | failure | unknown", "unknown")
  .option("--notes <text>", "附加备注")
  .option("--stdout", "同时将反馈包打印到标准输出", false)
  .option("--no-redact", "禁用路径与常见密钥脱敏")
  .action((sessionId, options) => {
    const workspaceRoot = resolveWorkspaceRoot();
    const config = loadConfig(workspaceRoot);
    const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath(workspaceRoot) });
    try {
      const session = resolveFeedbackSession(runtime, workspaceRoot, sessionId, options.host);
      const result = writeFeedbackBundle(runtime, config, session, {
        outPath: options.out,
        redact: options.redact,
        eventLimit: Number(options.eventLimit),
        artifactLimit: Number(options.artifactLimit),
        checkpointLimit: Number(options.checkpointLimit),
        label: options.label,
        notes: options.notes,
        trrVersion: TRR_VERSION
      });
      if (options.stdout) {
        console.log(JSON.stringify(result.bundle, null, 2));
        return;
      }
      console.log(
        JSON.stringify(
          {
            outputPath: result.outputPath,
            sessionId: result.bundle.session.id,
            host: result.bundle.session.host,
            redacted: result.bundle.redacted,
            summary: result.bundle.summary
          },
          null,
          2
        )
      );
    } finally {
      runtime.close();
    }
  });

program
  .command("trace")
  .description("标准化 trace 的导入、采集与回放")
  .addCommand(
    new Command("normalize-codex")
      .requiredOption("--file <path>", "Codex archived session JSONL")
      .option("--out <path>", "write normalized trace JSON to file")
      .option("--no-redact", "disable redaction of local paths and common secrets")
      .action((options) => {
        const trace = normalizeCodexArchivedSession(options.file, {
          redact: options.redact
        });
        const output = JSON.stringify(trace, null, 2);
        if (options.out) {
          fs.writeFileSync(options.out, output);
        } else {
          console.log(output);
        }
      })
  )
  .addCommand(
    new Command("normalize-claude")
      .requiredOption("--session <id>", "Claude session id from history.jsonl")
      .option("--history <path>", "Claude history.jsonl path")
      .option("--todos <path>", "Claude todos directory path")
      .option("--out <path>", "write normalized trace JSON to file")
      .option("--no-redact", "disable redaction of local paths and common secrets")
      .action((options) => {
        const windowsHome = path.dirname(process.env.CODEX_HOME || "");
        const historyPath = options.history || path.join(windowsHome, ".claude", "history.jsonl");
        const todosDir = options.todos || path.join(windowsHome, ".claude", "todos");
        const trace = normalizeClaudeSession(historyPath, todosDir, options.session, {
          redact: options.redact
        });
        const output = JSON.stringify(trace, null, 2);
        if (options.out) {
          fs.writeFileSync(options.out, output);
        } else {
          console.log(output);
        }
      })
  )
  .addCommand(
    new Command("harvest-local")
      .option("--out-dir <path>", "output directory for normalized traces", ".tmp/harvested-traces")
      .option("--max-codex <n>", "max number of Codex sessions", "20")
      .option("--max-claude <n>", "max number of Claude sessions", "30")
      .option("--min-claude-messages <n>", "minimum substantive Claude messages per session", "2")
      .option("--no-redact", "disable redaction of local paths and common secrets")
      .action((options) => {
        const manifest = harvestLocalTraces({
          outDir: options.outDir,
          redact: options.redact,
          maxCodexSessions: Number(options.maxCodex),
          maxClaudeSessions: Number(options.maxClaude),
          minClaudeMessages: Number(options.minClaudeMessages)
        });
        console.log(JSON.stringify(manifest, null, 2));
      })
  )
  .addCommand(
    new Command("import")
      .requiredOption("--file <path>", "normalized trace JSON file")
      .option("--session-id <id>", "override imported session id")
      .option("--create-checkpoint", "create checkpoint after import")
      .option("--force-checkpoint", "force checkpoint creation", false)
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
        const trace = loadTraceFile(options.file);
        const result = importTrace(runtime, trace, {
          sessionId: options.sessionId,
          createCheckpoint: options.createCheckpoint ? true : undefined,
          forceCheckpoint: options.forceCheckpoint ? true : undefined
        });
        const sessionDigest = runtime.sessionDigest(result.sessionId);
        runtime.close();
        console.log(
          JSON.stringify(
            {
              ...result,
              sessionDigest
            },
            null,
            2
          )
        );
      })
  )
  .addCommand(
    new Command("replay")
      .requiredOption("--file <path>", "normalized trace JSON file")
      .option("--format <format>", "json | markdown", "json")
      .option("--out <path>", "write output to file")
      .action((options) => {
        const trace = loadTraceFile(options.file);
        const dataset = traceToEvalDataset(trace);
        const report = runEval(dataset);
        const output =
          options.format === "markdown"
            ? renderEvalMarkdown(report)
            : JSON.stringify(report, null, 2);
        if (options.out) {
          fs.writeFileSync(options.out, output);
        } else {
          console.log(output);
        }
      })
  )
  .addCommand(
    new Command("live-replay")
      .requiredOption("--file <path>", "normalized trace JSON file")
      .requiredOption("--provider <provider>", "openai | anthropic")
      .requiredOption("--model <model>", "model id")
      .option("--strategy <strategy>", "full_history | simple_summary | runtime | all", "all")
      .option("--format <format>", "json | markdown", "json")
      .option("--out <path>", "write output to file")
      .option("--instruction <text>", "live replay system prompt override")
      .option("--max-output-tokens <n>", "max output tokens")
      .option("--temperature <n>", "temperature")
      .action(async (options) => {
        const trace = loadTraceFile(options.file);
        const dataset = traceToEvalDataset(trace);
        const strategies =
          options.strategy === "all"
            ? undefined
            : [options.strategy as "full_history" | "simple_summary" | "runtime"];
        const report = await runLiveReplay(dataset, {
          provider: options.provider,
          model: options.model,
          strategies,
          instruction: options.instruction,
          maxOutputTokens: options.maxOutputTokens ? Number(options.maxOutputTokens) : undefined,
          temperature: options.temperature ? Number(options.temperature) : undefined
        });
        const output =
          options.format === "markdown"
            ? renderLiveReplayMarkdown(report)
            : JSON.stringify(report, null, 2);
        if (options.out) {
          fs.writeFileSync(options.out, output);
        } else {
          console.log(output);
        }
      })
  );

program
  .command("guard")
  .description("重复执行保护相关命令")
  .addCommand(
    new Command("check")
      .requiredOption("--session <session>", "session id")
      .option("--action-file <path>", "action JSON file")
      .option("--action-json <json>", "inline action JSON")
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
        const fromFile = options.actionFile ? parseJsonFile(options.actionFile) : undefined;
        const inline = parseInlineJson(options.actionJson);
        const action = { ...(fromFile ?? {}), ...(inline ?? {}) } as unknown as ProposedAction;
        if (!action.actionType) {
          runtime.close();
          throw new Error("actionType is required in action JSON");
        }
        const result = runtime.assessAction(options.session, action);
        runtime.close();
        console.log(JSON.stringify(result, null, 2));
      })
  );

program
  .command("eval")
  .description("运行恢复效果评测")
  .addCommand(
    new Command("run")
      .option(
        "--dataset <path>",
        "dataset JSON path",
        "benchmarks/recovery-benchmark.json"
      )
      .option("--format <format>", "json | markdown", "json")
      .option("--out <path>", "write output to file")
      .action((options) => {
        const dataset = loadEvalDataset(options.dataset);
        const report = runEval(dataset);
        const output =
          options.format === "markdown"
            ? renderEvalMarkdown(report)
            : JSON.stringify(report, null, 2);
        if (options.out) {
          fs.writeFileSync(options.out, output);
        } else {
          console.log(output);
        }
      })
  )
  .addCommand(
    new Command("corpus")
      .requiredOption("--dir <path>", "directory of normalized trace JSON files")
      .option("--name <name>", "dataset name override")
      .option("--min-events <n>", "minimum event count")
      .option("--min-user-messages <n>", "minimum user_message count")
      .option("--host <hosts>", "comma-separated host filter, for example codex,claude")
      .option("--quality <qualities>", "comma-separated quality filter, for example high,medium")
      .option("--max-scenarios <n>", "maximum included scenarios")
      .option("--no-require-expected", "allow traces without expected assertions")
      .option("--no-require-next-action", "allow traces without expected.nextAction")
      .option("--format <format>", "json | markdown", "json")
      .option("--out <path>", "write output to file")
      .action((options) => {
        const corpus = loadTraceCorpus({
          dir: options.dir,
          name: options.name,
          minEvents: options.minEvents ? Number(options.minEvents) : undefined,
          minUserMessages: options.minUserMessages ? Number(options.minUserMessages) : undefined,
          requireExpected: options.requireExpected,
          requireNextAction: options.requireNextAction,
          hosts: parseCsvList(options.host),
          qualities: parseCsvList(options.quality),
          maxScenarios: options.maxScenarios ? Number(options.maxScenarios) : undefined
        });
        if (corpus.dataset.scenarios.length === 0) {
          throw new Error("no traces matched the corpus filters");
        }
        const report = runEval(corpus.dataset);
        const output =
          options.format === "markdown"
            ? renderTraceCorpusEvalMarkdown(corpus, report)
            : JSON.stringify(
                {
                  corpus,
                  report
                },
                null,
                2
              );
        if (options.out) {
          fs.writeFileSync(options.out, output);
        } else {
          console.log(output);
        }
      })
  );

program
  .command("turn")
  .description("通过 provider adapter 发送一轮文本")
  .addCommand(
    new Command("send")
      .requiredOption("--session <session>", "session id")
      .requiredOption("--user-input <text>", "user text for the next turn")
      .option("--system-prompt <text>", "system prompt override")
      .option("--max-output-tokens <n>", "max output tokens")
      .option("--temperature <n>", "temperature")
      .action(async (options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath() });
        const session = runtime.getSession(options.session);
        runtime.recordEvent({
          sessionId: session.id,
          kind: "user_message",
          payload: { text: options.userInput }
        });
        const packet = runtime.buildResumePacket(session.id, { excludeLatestUser: true });
        const adapter =
          session.provider === "openai"
            ? new OpenAIAdapter()
            : session.provider === "anthropic"
              ? new AnthropicAdapter()
              : undefined;
        if (!adapter) {
          runtime.close();
          throw new Error(`unsupported provider for turn.send: ${session.provider}`);
        }
        const result = await adapter.sendTurn({
          model: session.model,
          systemPrompt: options.systemPrompt,
          runtimePacket: packet.packet,
          userInput: options.userInput,
          maxOutputTokens: options.maxOutputTokens ? Number(options.maxOutputTokens) : undefined,
          temperature: options.temperature ? Number(options.temperature) : undefined
        });
        const assistantEvent = runtime.recordEvent({
          sessionId: session.id,
          kind: "assistant_message",
          payload: { text: result.text }
        });
        runtime.maybeCompact(session.id);
        runtime.close();
        console.log(
          JSON.stringify(
            {
              assistantEventId: assistantEvent.id,
              text: result.text
            },
            null,
            2
          )
        );
      })
  );

program
  .command("config")
  .description("配置相关命令")
  .addCommand(
    new Command("init").action(() => {
      const workspaceRoot = resolveWorkspaceRoot();
      const configPath = writeDefaultConfig(workspaceRoot);
      console.log(configPath);
    })
  );

program
  .command("env")
  .description("输出当前终端的激活脚本，使 codex/claude 自动经过 trr")
  .option("--shell <shell>", "bash | zsh | fish | powershell")
  .action((options) => {
    const shell = detectShellName(options.shell);
    const launcher = resolveShellLauncher(resolveWorkspaceRoot());
    process.stdout.write(renderShellActivation(shell, launcher));
  });

program
  .command("install-shell")
  .description("安装持久 shell 集成，使 codex/claude 自动经过 trr")
  .option("--shell <shell>", "bash | zsh | fish | powershell")
  .option("--rc-file <path>", "override rc/profile path")
  .action((options) => {
    const workspaceRoot = resolveWorkspaceRoot();
    const shell = detectShellName(options.shell);
    const launcher = resolveShellLauncher(workspaceRoot);
    const result = installShellIntegration(workspaceRoot, shell, options.rcFile, launcher);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("install-claude-hooks")
  .description("在当前工作区安装官方 Claude Code hooks")
  .action(() => {
    const workspaceRoot = resolveWorkspaceRoot();
    const result = installClaudeHooks(workspaceRoot);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("install-codex-hooks")
  .description("在 CODEX_HOME 安装官方 Codex hooks，使普通 codex 会话调用 trr")
  .option("--codex-home <path>", "override CODEX_HOME")
  .action((options) => {
    const result = installCodexHooks(codexHomeDir(options.codexHome));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("setup")
  .description("一键完成本地初始化：配置、shell 集成、Codex hooks、Claude hooks")
  .option("--shell <shell>", "bash | zsh | fish | powershell")
  .option("--rc-file <path>", "override rc/profile path for shell integration")
  .option("--codex-home <path>", "override CODEX_HOME")
  .option("--skip-shell", "do not install shell integration", false)
  .option("--skip-codex-hooks", "do not install Codex hooks", false)
  .option("--skip-claude-hooks", "do not install Claude hooks", false)
  .action((options) => {
    const workspaceRoot = resolveWorkspaceRoot();
    const configPath = writeDefaultConfig(workspaceRoot);
    const config = loadConfig(workspaceRoot);
    const shimDir = ensureShimDirectory(config.workspaceRoot, config.guardPolicy);
    const shell = detectShellName(options.shell);
    const launcher = resolveShellLauncher(workspaceRoot);
    const shellIntegration = options.skipShell
      ? undefined
      : installShellIntegration(workspaceRoot, shell, options.rcFile, launcher);
    const codexHooks = options.skipCodexHooks
      ? undefined
      : installCodexHooks(codexHomeDir(options.codexHome));
    const claudeHooks = options.skipClaudeHooks ? undefined : installClaudeHooks(workspaceRoot);

    console.log(
      JSON.stringify(
        {
          workspaceRoot,
          configPath,
          shimDir,
          shellIntegration,
          codexHooks,
          claudeHooks,
          next: "Open a new terminal, then run codex or claude normally."
        },
        null,
        2
      )
    );
  });

program
  .command("smoke")
  .description("运行内置本地 smoke，验证恢复、guard 与重启链路")
  .option("--format <format>", "json | markdown", "json")
  .action(async (options) => {
    const { renderSmokeMarkdown, runLocalSmoke } = await import("./smoke");
    const report = await runLocalSmoke();
    const output =
      options.format === "markdown"
        ? renderSmokeMarkdown(report)
        : JSON.stringify(report, null, 2);
    console.log(output);
  });

program
  .command("hook")
  .description("宿主内部 hook 处理命令")
  .addCommand(
    new Command("claude").action(() => {
      const raw = fs.readFileSync(0, "utf8");
      const payload = (raw.trim() ? JSON.parse(raw) : {}) as JsonObject;
      const response = handleClaudeHook(payload);
      if (response) {
        console.log(JSON.stringify(response));
      }
    })
  )
  .addCommand(
    new Command("codex").action(() => {
      const raw = fs.readFileSync(0, "utf8");
      const payload = (raw.trim() ? JSON.parse(raw) : {}) as JsonObject;
      const response = handleCodexHook(payload);
      if (response) {
        console.log(JSON.stringify(response));
      }
    })
  );

program.command("sessions").description("列出最近的包装会话").action(() => {
  const workspaceRoot = resolveWorkspaceRoot();
  const runtime = new TaskRecoveryRuntime({ dbPath: effectiveDbPath(workspaceRoot) });
  const rows = runtime.listSessions().map((session) => {
    const checkpoint = runtime.getLatestCheckpoint(session.id);
    const lastEvent = runtime.listEvents(session.id).slice(-1)[0];
    return {
      id: session.id,
      host: session.host || "unknown",
      workspaceRoot: session.workspaceRoot,
      model: session.model,
      createdAt: session.createdAt,
      nextAction: checkpoint?.nextAction,
      phase: checkpoint?.phase,
      lastEventKind: lastEvent?.kind,
      lastEventAt: lastEvent?.ts
    };
  });
  runtime.close();
  console.log(JSON.stringify(rows, null, 2));
});

program.command("doctor").description("检查宿主、shim、配置和 store 的就绪状态").action(() => {
  const workspaceRoot = resolveWorkspaceRoot();
  const config = loadConfig(workspaceRoot);
  const storePath = effectiveDbPath(workspaceRoot);
  const shimDir = ensureShimDirectory(config.workspaceRoot, config.guardPolicy);
  const workspaceSnapshot = captureWorkspaceSnapshot(config.workspaceRoot);
  const detectedShell = detectShellName();
  const launcher = resolveShellLauncher(workspaceRoot);
  const shellScriptPath = ensureShellIntegrationScript(config.workspaceRoot, detectedShell, launcher);
  const shellRcFile = defaultRcFilePath(detectedShell);
  const shellRcContent = fs.existsSync(shellRcFile) ? fs.readFileSync(shellRcFile, "utf8") : "";
  const codexHooks = codexHookInstallState();
  const checks = {
    workspaceRoot: config.workspaceRoot,
    configPath: path.join(config.workspaceRoot, "trr.config.json"),
    storePath,
    shimDir,
    hostCommands: {
      codex: Boolean(findRealExecutable(config.hostProfiles.codex.command, process.env.PATH || "")),
      claude: Boolean(findRealExecutable(config.hostProfiles.claude.command, process.env.PATH || ""))
    },
    hostDetection: {
      codex: config.hostProfiles.codex.detection,
      claude: config.hostProfiles.claude.detection,
      "generic-pty": config.hostProfiles["generic-pty"].detection
    },
    shimReady: fs.existsSync(shimDir),
    shellIntegration: {
      detectedShell,
      launcher,
      scriptPath: shellScriptPath,
      rcFilePath: shellRcFile,
      installedInRc: isShellIntegrationInstalled(detectedShell, shellRcContent, shellScriptPath)
    },
    codexHooks,
    workspaceSnapshot
  };
  console.log(JSON.stringify(checks, null, 2));
});

program
  .command("wrap")
  .description("启动带恢复与 guard 能力的包装宿主")
  .option("--workspace-root <path>", "override workspace root for this wrapped host launch")
  .argument("<host>", "codex | claude | generic-pty")
  .argument("[cmd...]", "optional host args, or generic-pty command after --")
  .action(async function (this: Command, host: string, cmd: string[] | undefined) {
    const options = this.opts<{ workspaceRoot?: string }>();
    const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot || process.cwd());
    maybeRespawnForPty(workspaceRoot);
    const { wrapHost } = await import("./wrap");
    const config = loadConfig(workspaceRoot);
    const result = await wrapHost({
      host,
      workspaceRoot,
      config,
      dbPath: effectiveDbPath(workspaceRoot),
      passthroughArgs: cmd ?? []
    });
    if (!process.stdout.isTTY) {
      console.log(JSON.stringify(result, null, 2));
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
