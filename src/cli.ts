#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { AnthropicAdapter } from "./adapters/anthropic";
import { OpenAIAdapter } from "./adapters/openai";
import { loadTraceCorpus } from "./evals/corpus";
import { loadEvalDataset } from "./evals/dataset";
import { renderEvalMarkdown, renderTraceCorpusEvalMarkdown } from "./evals/report";
import { runEval } from "./evals/runner";
import {
  harvestLocalTraces,
  normalizeClaudeSession,
  normalizeCodexArchivedSession
} from "./host-importers";
import { renderLiveReplayMarkdown, runLiveReplay } from "./live-eval";
import { TaskRecoveryRuntime } from "./runtime";
import { importTrace, loadTraceFile, traceToEvalDataset } from "./traces";
import type { JsonObject, ProposedAction } from "./types";

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

const program = new Command();
program.name("trr").description("Task Recovery Runtime CLI").version("0.1.1");

program.option("--db <path>", "local store file path", ".tmp/trr-store.json");

program
  .command("session")
  .description("session commands")
  .addCommand(
    new Command("create")
      .requiredOption("--provider <provider>", "openai | anthropic | custom")
      .requiredOption("--model <model>", "model id")
      .option("--workspace <path>", "workspace root")
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
        const session = runtime.createSession({
          provider: options.provider,
          model: options.model,
          workspaceRoot: options.workspace
        });
        runtime.close();
        console.log(JSON.stringify(session, null, 2));
      })
  )
  .addCommand(
    new Command("list").action(() => {
      const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
      console.log(JSON.stringify(runtime.listSessions(), null, 2));
      runtime.close();
    })
  );

program
  .command("event")
  .description("event commands")
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
        const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
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
        const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
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
  .description("checkpoint commands")
  .addCommand(
    new Command("create")
      .requiredOption("--session <session>", "session id")
      .option("--force", "force checkpoint even if pending activity", false)
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
        const checkpoint = runtime.createCheckpoint(options.session, options.force);
        runtime.close();
        console.log(JSON.stringify(checkpoint, null, 2));
      })
  )
  .addCommand(
    new Command("show")
      .requiredOption("--session <session>", "session id")
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
        const checkpoint = runtime.getLatestCheckpoint(options.session);
        runtime.close();
        console.log(JSON.stringify(checkpoint, null, 2));
      })
  );

program
  .command("resume")
  .description("resume packet commands")
  .addCommand(
    new Command("build")
      .requiredOption("--session <session>", "session id")
      .option("--exclude-latest-user", "exclude the latest user message", false)
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
        const packet = runtime.buildResumePacket(options.session, {
          excludeLatestUser: options.excludeLatestUser
        });
        runtime.close();
        console.log(packet.packet);
      })
  );

program
  .command("trace")
  .description("normalized trace import and replay")
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
        const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
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
  .description("repeat guard commands")
  .addCommand(
    new Command("check")
      .requiredOption("--session <session>", "session id")
      .option("--action-file <path>", "action JSON file")
      .option("--action-json <json>", "inline action JSON")
      .action((options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
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
  .description("run recovery benchmark evaluation")
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
  .description("send a text turn through the provider adapter")
  .addCommand(
    new Command("send")
      .requiredOption("--session <session>", "session id")
      .requiredOption("--user-input <text>", "user text for the next turn")
      .option("--system-prompt <text>", "system prompt override")
      .option("--max-output-tokens <n>", "max output tokens")
      .option("--temperature <n>", "temperature")
      .action(async (options) => {
        const runtime = new TaskRecoveryRuntime({ dbPath: program.opts().db });
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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
