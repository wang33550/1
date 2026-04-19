import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TraceImportFile } from "./traces";
import { nowIso, normalizeWhitespace, safeText, stableStringify } from "./utils";

type JsonRecord = Record<string, unknown>;

export interface NormalizeTraceOptions {
  redact?: boolean;
  traceId?: string;
  description?: string;
}

export interface HarvestLocalOptions {
  outDir: string;
  redact?: boolean;
  maxCodexSessions?: number;
  maxClaudeSessions?: number;
  minClaudeMessages?: number;
}

export interface HarvestManifestEntry {
  id: string;
  host: "codex" | "claude";
  quality: "high" | "medium";
  sourcePath: string;
  outputPath: string;
  workspaceRoot?: string;
  eventCount: number;
  userMessageCount: number;
  expectedNextAction?: string;
}

export interface HarvestManifest {
  generatedAt: string;
  outDir: string;
  entries: HarvestManifestEntry[];
  skipped: Array<{ sourcePath: string; reason: string }>;
}

interface CodexCallInfo {
  name: string;
  arguments?: JsonRecord;
}

interface ClaudeHistoryRow {
  display: string;
  pastedContents?: Record<string, unknown>;
  timestamp: number;
  project?: string;
  sessionId: string;
}

function ensureDir(targetPath: string): void {
  fs.mkdirSync(targetPath, { recursive: true });
}

function readJsonLines(filePath: string): JsonRecord[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => normalizeWhitespace(line))
      .find(Boolean) || ""
  );
}

function truncateText(value: string, length = 72): string {
  const normalized = normalizeWhitespace(value);
  return normalized.length <= length ? normalized : `${normalized.slice(0, length - 3)}...`;
}

function summarizeCommandOutput(text: string): string {
  const outputMatch = text.match(/\nOutput:\n([\s\S]*)$/);
  if (!outputMatch) return "";
  const summary = firstLine(outputMatch[1] || "");
  return summary.length > 200 ? `${summary.slice(0, 197)}...` : summary;
}

function parseExecOutput(text: string): {
  command?: string;
  exitCode?: number;
  summary?: string;
  runningSessionId?: string;
} {
  const command = text.match(/Command:\s([^\n]+)/)?.[1];
  const exitCodeRaw = text.match(/Process exited with code (-?\d+)/)?.[1];
  const runningSessionId = text.match(/Process running with session ID (\d+)/)?.[1];
  const exitCode =
    exitCodeRaw !== undefined && Number.isFinite(Number(exitCodeRaw))
      ? Number(exitCodeRaw)
      : undefined;
  const summary = summarizeCommandOutput(text);
  return {
    command: command ? normalizeWhitespace(command) : undefined,
    exitCode,
    summary: summary || undefined,
    runningSessionId
  };
}

function safeJsonParse(value: string | undefined): JsonRecord | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as JsonRecord;
  } catch {
    return undefined;
  }
}

function planItemsFromUpdatePlan(args: JsonRecord | undefined): Array<{ id: string; text: string; status: string }> {
  const rawPlan = Array.isArray(args?.plan) ? args.plan : [];
  return rawPlan
    .map((item, index) => {
      if (!item || typeof item !== "object") return undefined;
      const row = item as JsonRecord;
      const text = normalizeWhitespace(safeText(row.step ?? row.text));
      const status = normalizeWhitespace(safeText(row.status || "pending")) || "pending";
      if (!text) return undefined;
      return {
        id: safeText(row.id) || `plan_${index}`,
        text,
        status
      };
    })
    .filter((item): item is { id: string; text: string; status: string } => Boolean(item));
}

function nextActionFromPlanItems(items: Array<{ text: string; status: string }>): string | undefined {
  return (
    items.find((item) => item.status === "in_progress")?.text ||
    items.find((item) => item.status === "pending")?.text ||
    undefined
  );
}

function isLikelySideEffect(command: string): boolean {
  return /\b(git\s+(commit|push|tag)|rm\b|mv\b|cp\b|mkdir\b|touch\b|chmod\b|chown\b|curl\b|wget\b|invoke-webrequest\b|deploy\b|publish\b|release\b|xsim\b|xvlog\b|xelab\b|apply_patch\b)\b/i.test(
    command
  );
}

function inferFileRead(command: string): { path?: string; startLine?: number; endLine?: number } | undefined {
  const sedMatch = command.match(/sed\s+-n\s+'(\d+),(\d+)p'\s+(.+)$/);
  if (sedMatch) {
    return {
      startLine: Number(sedMatch[1]),
      endLine: Number(sedMatch[2]),
      path: sedMatch[3]?.replace(/^['"]|['"]$/g, "")
    };
  }
  const catMatch = command.match(/\bcat\s+(.+)$/);
  if (catMatch) {
    return {
      path: catMatch[1]?.replace(/^['"]|['"]$/g, "")
    };
  }
  const nlMatch = command.match(/\bnl\b(?:\s+-ba)?\s+(.+)$/);
  if (nlMatch) {
    return {
      path: nlMatch[1]?.replace(/^['"]|['"]$/g, "")
    };
  }
  return undefined;
}

function inferWindowsUserHome(): string | undefined {
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) {
    return path.dirname(codexHome);
  }
  const home = os.homedir();
  return home.includes("/mnt/") ? home : undefined;
}

function defaultCodexHome(): string | undefined {
  return process.env.CODEX_HOME || path.join(inferWindowsUserHome() || "", ".codex");
}

function defaultClaudeHome(): string | undefined {
  const base = inferWindowsUserHome();
  return base ? path.join(base, ".claude") : undefined;
}

function buildRedactor(trace: TraceImportFile): (value: string) => string {
  const replacements: Array<[RegExp, string]> = [];
  const windowsHome = inferWindowsUserHome();
  if (windowsHome) {
    const normalizedHome = windowsHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    replacements.push([new RegExp(normalizedHome, "gi"), "$HOME_WIN"]);
  }

  const workspaceRoot = trace.session.workspaceRoot;
  if (workspaceRoot) {
    const escapedWorkspace = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    replacements.push([new RegExp(escapedWorkspace, "gi"), "$WORKSPACE"]);
  }

  replacements.push([/C:\\Users\\[^\\]+/gi, "%USERPROFILE%"]);
  replacements.push([/\/mnt\/[a-z]\/Users\/[^/]+/gi, "$HOME_WIN"]);
  replacements.push([/sk-[A-Za-z0-9_\-]+/g, "[REDACTED_API_KEY]"]);
  replacements.push([/\bBearer\s+[A-Za-z0-9._\-]+\b/gi, "Bearer [REDACTED]"]);
  replacements.push([/\b[A-Fa-f0-9]{32,64}\b/g, "[REDACTED_HEX]"]);

  return (value: string) => {
    let next = value;
    for (const [pattern, replacement] of replacements) {
      next = next.replace(pattern, replacement);
    }
    return next;
  };
}

function redactTrace(trace: TraceImportFile): TraceImportFile {
  const redact = buildRedactor(trace);
  return {
    ...trace,
    description: trace.description ? redact(trace.description) : trace.description,
    source: trace.source
      ? {
          ...trace.source,
          notes: trace.source.notes ? redact(trace.source.notes) : trace.source.notes
        }
      : trace.source,
    session: {
      ...trace.session,
      workspaceRoot: trace.session.workspaceRoot
        ? redact(trace.session.workspaceRoot)
        : trace.session.workspaceRoot
    },
    events: trace.events.map((event) => ({
      ...event,
      payload: JSON.parse(redact(stableStringify(event.payload))) as Record<string, unknown>
    })),
    expected: trace.expected
      ? {
          ...trace.expected,
          nextAction: trace.expected.nextAction
            ? redact(trace.expected.nextAction)
            : trace.expected.nextAction,
          requiredConstraints: trace.expected.requiredConstraints?.map((item) => redact(item)),
          requiredArtifacts: trace.expected.requiredArtifacts?.map((item) => redact(item))
        }
      : trace.expected
  };
}

function sortByMtimeDesc(filePaths: string[]): string[] {
  return [...filePaths].sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

function uniqueClaudeSessions(rows: ClaudeHistoryRow[]): string[] {
  return [...new Set(rows.map((row) => row.sessionId))];
}

function meaningfulClaudeMessage(text: string): boolean {
  const trimmed = normalizeWhitespace(text);
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return false;
  if (["clear", "run"].includes(trimmed.toLowerCase())) return false;
  return true;
}

export function normalizeCodexArchivedSession(
  filePath: string,
  options: NormalizeTraceOptions = {}
): TraceImportFile {
  const rows = readJsonLines(filePath);
  const pendingCalls = new Map<string, CodexCallInfo>();
  const events: TraceImportFile["events"] = [];

  let sessionId = path.basename(filePath, ".jsonl");
  let model = "codex";
  let workspaceRoot: string | undefined;
  let description = options.description;
  let expectedNextAction: string | undefined;

  for (const row of rows) {
    const type = safeText(row.type);
    const payload = (row.payload as JsonRecord | undefined) ?? {};
    const timestamp = safeText(row.timestamp) || undefined;

    if (type === "session_meta") {
      sessionId = safeText(payload.id) || sessionId;
      workspaceRoot = normalizeWhitespace(safeText(payload.cwd)) || workspaceRoot;
      description = description || truncateText(safeText(payload.thread_name));
    }

    if (type === "turn_context") {
      model = normalizeWhitespace(safeText(payload.model)) || model;
      workspaceRoot = normalizeWhitespace(safeText(payload.cwd)) || workspaceRoot;
    }

    if (type === "event_msg") {
      const eventType = safeText(payload.type);
      if (eventType === "user_message") {
        const text = normalizeWhitespace(safeText(payload.message));
        if (!text) continue;
        events.push({
          kind: "user_message",
          payload: { text },
          ts: timestamp
        });
        description = description || truncateText(text);
      } else if (eventType === "agent_message") {
        const text = normalizeWhitespace(safeText(payload.message));
        if (!text) continue;
        events.push({
          kind: "assistant_message",
          payload: {
            text,
            phase: safeText(payload.phase) || undefined
          },
          ts: timestamp
        });
      }
      continue;
    }

    if (type !== "response_item") continue;
    const itemType = safeText(payload.type);
    const callId = safeText(payload.call_id);

    if (itemType === "function_call") {
      const name = normalizeWhitespace(safeText(payload.name));
      const args = safeJsonParse(safeText(payload.arguments));
      if (callId && name) {
        pendingCalls.set(callId, { name, arguments: args });
      }

      if (name === "update_plan") {
        const items = planItemsFromUpdatePlan(args);
        if (items.length > 0) {
          const nextAction = nextActionFromPlanItems(items);
          expectedNextAction = nextAction || expectedNextAction;
          events.push({
            kind: "plan_update",
            payload: {
              items,
              nextAction
            },
            ts: timestamp
          });
        }
      } else if (name && name !== "exec_command" && name !== "write_stdin") {
        events.push({
          kind: "tool_call",
          payload: {
            toolName: name,
            input: args,
            summary: args ? truncateText(stableStringify(args), 240) : undefined
          },
          ts: timestamp
        });
      }
      continue;
    }

    if (itemType === "function_call_output") {
      const text = safeText(payload.output);
      const call = callId ? pendingCalls.get(callId) : undefined;

      if (call?.name === "exec_command" || /Command:\s/.test(text)) {
        const parsed = parseExecOutput(text);
        if (parsed.command && parsed.exitCode !== undefined) {
          const fileRead = inferFileRead(parsed.command);
          if (fileRead?.path) {
            events.push({
              kind: "file_read",
              payload: {
                path: fileRead.path,
                startLine: fileRead.startLine,
                endLine: fileRead.endLine
              },
              ts: timestamp
            });
          }
          events.push({
            kind: "command_exec",
            payload: {
              command: parsed.command,
              cwd: call?.arguments?.workdir ? safeText(call.arguments.workdir) : workspaceRoot,
              exitCode: parsed.exitCode,
              summary: parsed.summary,
              sideEffect: isLikelySideEffect(parsed.command)
            },
            ts: timestamp
          });
        }
      } else if (call?.name && call.name !== "write_stdin") {
        events.push({
          kind: "tool_result",
          payload: {
            toolName: call.name,
            summary: truncateText(firstLine(text), 240)
          },
          ts: timestamp
        });
      }
    }
  }

  const trace: TraceImportFile = {
    version: "trr_trace_v1",
    description: description || `Imported Codex session ${sessionId}`,
    source: {
      host: "codex",
      traceId: options.traceId || sessionId,
      exportedAt: nowIso(),
      exporter: "trr_codex_importer",
      notes: "Normalized from Codex archived session JSONL."
    },
    session: {
      provider: "openai",
      model,
      workspaceRoot,
      id: options.traceId || sessionId
    },
    minTailEvents: 3,
    checkpoint: {
      create: true,
      force: true
    },
    events,
    expected: expectedNextAction
      ? {
          nextAction: expectedNextAction
        }
      : undefined
  };

  return options.redact === false ? trace : redactTrace(trace);
}

export function loadClaudeHistory(historyPath: string): ClaudeHistoryRow[] {
  return readJsonLines(historyPath)
    .map((row) => ({
      display: safeText(row.display),
      pastedContents:
        row.pastedContents && typeof row.pastedContents === "object"
          ? (row.pastedContents as Record<string, unknown>)
          : undefined,
      timestamp: Number(row.timestamp ?? 0),
      project: normalizeWhitespace(safeText(row.project)) || undefined,
      sessionId: safeText(row.sessionId)
    }))
    .filter((row) => row.sessionId && Number.isFinite(row.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function normalizeClaudeSession(
  historyPath: string,
  todosDir: string,
  sessionId: string,
  options: NormalizeTraceOptions = {}
): TraceImportFile {
  const rows = loadClaudeHistory(historyPath).filter((row) => row.sessionId === sessionId);
  const meaningfulRows = rows.filter((row) => meaningfulClaudeMessage(row.display));
  if (meaningfulRows.length === 0) {
    throw new Error(`no meaningful Claude messages found for session ${sessionId}`);
  }

  const events: TraceImportFile["events"] = meaningfulRows.map((row) => ({
    kind: "user_message",
    payload: {
      text: normalizeWhitespace(row.display)
    },
    ts: new Date(row.timestamp).toISOString()
  }));

  const todoPath = path.join(todosDir, `${sessionId}-agent-${sessionId}.json`);
  let expectedNextAction: string | undefined;
  if (fs.existsSync(todoPath)) {
    const raw = JSON.parse(fs.readFileSync(todoPath, "utf8")) as unknown;
    if (Array.isArray(raw) && raw.length > 0) {
      const items = raw
        .map((item, index) => {
          if (!item || typeof item !== "object") return undefined;
          const row = item as JsonRecord;
          const text = normalizeWhitespace(safeText(row.content || row.text));
          const status = normalizeWhitespace(safeText(row.status || "pending")) || "pending";
          if (!text) return undefined;
          return {
            id: safeText(row.id) || `todo_${index}`,
            text,
            status: status === "completed" ? "done" : status
          };
        })
        .filter((item): item is { id: string; text: string; status: string } => Boolean(item));

      if (items.length > 0) {
        expectedNextAction = nextActionFromPlanItems(items);
        events.push({
          kind: "plan_update",
          payload: {
            items,
            nextAction: expectedNextAction
          },
          ts: fs.statSync(todoPath).mtime.toISOString()
        });
      }
    }
  }

  const workspaceRoot = meaningfulRows[meaningfulRows.length - 1]?.project;
  const firstPrompt = normalizeWhitespace(meaningfulRows[0]?.display || "");
  const trace: TraceImportFile = {
    version: "trr_trace_v1",
    description: options.description || truncateText(firstPrompt),
    source: {
      host: "claude",
      traceId: options.traceId || sessionId,
      exportedAt: nowIso(),
      exporter: "trr_claude_importer",
      notes: "Normalized from Claude history.jsonl with optional todo state."
    },
    session: {
      provider: "anthropic",
      model: "claude-code",
      workspaceRoot,
      id: options.traceId || sessionId
    },
    minTailEvents: 2,
    checkpoint: {
      create: true,
      force: true
    },
    events,
    expected: expectedNextAction
      ? {
          nextAction: expectedNextAction
        }
      : undefined
  };

  return options.redact === false ? trace : redactTrace(trace);
}

function writeTraceFile(outputPath: string, trace: TraceImportFile): void {
  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, JSON.stringify(trace, null, 2));
}

export function harvestLocalTraces(options: HarvestLocalOptions): HarvestManifest {
  ensureDir(options.outDir);
  const redact = options.redact !== false;
  const maxCodexSessions = options.maxCodexSessions ?? 20;
  const maxClaudeSessions = options.maxClaudeSessions ?? 30;
  const minClaudeMessages = options.minClaudeMessages ?? 2;
  const entries: HarvestManifestEntry[] = [];
  const skipped: HarvestManifest["skipped"] = [];

  const codexHome = defaultCodexHome();
  const claudeHome = defaultClaudeHome();

  if (codexHome) {
    const codexArchiveDir = path.join(codexHome, "archived_sessions");
    if (fs.existsSync(codexArchiveDir)) {
      const files = sortByMtimeDesc(
        fs
          .readdirSync(codexArchiveDir)
          .filter((file) => file.endsWith(".jsonl"))
          .map((file) => path.join(codexArchiveDir, file))
      ).slice(0, maxCodexSessions);

      files.forEach((filePath, index) => {
        try {
          const traceId = `codex_${String(index + 1).padStart(3, "0")}`;
          const trace = normalizeCodexArchivedSession(filePath, {
            redact,
            traceId
          });
          if (trace.events.length === 0) {
            skipped.push({ sourcePath: filePath, reason: "no importable events" });
            return;
          }
          const outputPath = path.join(options.outDir, `${traceId}.json`);
          writeTraceFile(outputPath, trace);
          entries.push({
            id: traceId,
            host: "codex",
            quality: "high",
            sourcePath: filePath,
            outputPath,
            workspaceRoot: trace.session.workspaceRoot,
            eventCount: trace.events.length,
            userMessageCount: trace.events.filter((event) => event.kind === "user_message").length,
            expectedNextAction: trace.expected?.nextAction
          });
        } catch (error) {
          skipped.push({
            sourcePath: filePath,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
  }

  if (claudeHome) {
    const historyPath = path.join(claudeHome, "history.jsonl");
    const todosDir = path.join(claudeHome, "todos");
    if (fs.existsSync(historyPath) && fs.existsSync(todosDir)) {
      const history = loadClaudeHistory(historyPath);
      const candidateSessionIds = uniqueClaudeSessions(history).filter((sessionId) => {
        const count = history.filter(
          (row) => row.sessionId === sessionId && meaningfulClaudeMessage(row.display)
        ).length;
        return count >= minClaudeMessages;
      });

      candidateSessionIds.slice(0, maxClaudeSessions).forEach((sessionId, index) => {
        try {
          const traceId = `claude_${String(index + 1).padStart(3, "0")}`;
          const trace = normalizeClaudeSession(historyPath, todosDir, sessionId, {
            redact,
            traceId
          });
          const outputPath = path.join(options.outDir, `${traceId}.json`);
          writeTraceFile(outputPath, trace);
          entries.push({
            id: traceId,
            host: "claude",
            quality: "medium",
            sourcePath: `${historyPath}#${sessionId}`,
            outputPath,
            workspaceRoot: trace.session.workspaceRoot,
            eventCount: trace.events.length,
            userMessageCount: trace.events.filter((event) => event.kind === "user_message").length,
            expectedNextAction: trace.expected?.nextAction
          });
        } catch (error) {
          skipped.push({
            sourcePath: `${historyPath}#${sessionId}`,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
  }

  const manifest: HarvestManifest = {
    generatedAt: nowIso(),
    outDir: options.outDir,
    entries,
    skipped
  };

  fs.writeFileSync(path.join(options.outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return manifest;
}
