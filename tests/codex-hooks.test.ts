import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  codexHookInstallState,
  handleCodexHook,
  installCodexHooks,
  readCodexTranscriptTelemetry
} from "../src/codex-hooks";
import { TaskRecoveryRuntime } from "../src/runtime";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

function tempStorePath(workspace: string): string {
  return path.join(workspace, ".trr", "trr-store.json");
}

function writeTranscript(filePath: string, lines: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"));
}

describe("codex hooks", () => {
  test("installs global Codex hooks idempotently and enables the feature flag", () => {
    const codexHome = tempDir("codex-hooks-install");

    const first = installCodexHooks(codexHome);
    const second = installCodexHooks(codexHome);
    const hooks = JSON.parse(fs.readFileSync(first.hooksPath, "utf8")) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const config = fs.readFileSync(first.configPath, "utf8");
    const state = codexHookInstallState(codexHome);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.command).toBe("trr hook codex");
    expect(config).toContain("[features]");
    expect(config).toContain("codex_hooks = true");
    expect(hooks.hooks?.SessionStart?.[0]?.matcher).toBe("startup|resume");
    expect(hooks.hooks?.Stop?.[0]?.hooks[0]?.command).toBe("trr hook codex");
    expect(state.featureFlagEnabled).toBe(true);
    expect(state.installed).toBe(true);
  });

  test("parses Codex transcript token telemetry from session jsonl tails", () => {
    const workspace = tempDir("codex-telemetry");
    const transcriptPath = path.join(workspace, "session.jsonl");
    writeTranscript(transcriptPath, [
      {
        timestamp: "2026-04-21T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            model_context_window: 258400,
            last_token_usage: {
              input_tokens: 190000,
              cached_input_tokens: 150000,
              output_tokens: 512,
              total_tokens: 190512
            }
          },
          rate_limits: {
            primary: {
              used_percent: 11
            }
          }
        }
      }
    ]);

    const telemetry = readCodexTranscriptTelemetry(transcriptPath);

    expect(telemetry?.modelContextWindow).toBe(258400);
    expect(telemetry?.inputTokens).toBe(190000);
    expect(telemetry?.cachedInputTokens).toBe(150000);
    expect(telemetry?.quotaUsedPercent).toBe(11);
    expect(telemetry?.inputWindowFraction).toBeGreaterThan(0.73);
  });

  test("injects saved recovery state on Codex session resume", () => {
    const workspace = tempDir("codex-hooks-session-start");
    const storePath = tempStorePath(workspace);
    const runtime = new TaskRecoveryRuntime({ dbPath: storePath, minTailEvents: 1 });
    runtime.createSession({
      id: "codex-session-1",
      provider: "custom",
      model: "codex",
      host: "codex",
      workspaceRoot: workspace
    });
    runtime.recordEvent({
      sessionId: "codex-session-1",
      kind: "user_message",
      payload: {
        text: "Fix the refresh token bug."
      }
    });
    runtime.recordEvent({
      sessionId: "codex-session-1",
      kind: "plan_update",
      payload: {
        items: [{ id: "patch", text: "Patch token refresh logic", status: "in_progress" }],
        nextAction: "Patch token refresh logic"
      }
    });
    runtime.createCheckpoint("codex-session-1", true);
    runtime.close();

    const response = handleCodexHook(
      {
        session_id: "codex-session-1",
        hook_event_name: "SessionStart",
        source: "resume",
        model: "codex",
        cwd: workspace
      },
      workspace
    );

    expect(response).toBeTruthy();
    expect(
      (response?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext
    ).toContain("Patch token refresh logic");
  });

  test("returns Codex hook permission feedback for repeated dangerous commands", () => {
    const workspace = tempDir("codex-hooks-guard");
    const storePath = tempStorePath(workspace);
    const runtime = new TaskRecoveryRuntime({ dbPath: storePath, minTailEvents: 1 });
    runtime.createSession({
      id: "codex-session-2",
      provider: "custom",
      model: "codex",
      host: "codex",
      workspaceRoot: workspace
    });
    runtime.recordEvent({
      sessionId: "codex-session-2",
      kind: "plan_update",
      payload: {
        items: [{ id: "push", text: "Push release branch once checks pass", status: "pending" }],
        nextAction: "Push release branch once checks pass"
      }
    });
    runtime.recordEvent({
      sessionId: "codex-session-2",
      kind: "command_exec",
      payload: {
        command: "git push origin main",
        cwd: workspace,
        sideEffect: true,
        summary: "pushed once"
      }
    });
    runtime.createCheckpoint("codex-session-2", true);
    runtime.close();

    const response = handleCodexHook(
      {
        session_id: "codex-session-2",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "git push origin main"
        },
        cwd: workspace
      },
      workspace
    );

    expect(response).toBeTruthy();
    expect(
      (response?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision
    ).toBe("deny");
  });

  test("continues from saved state when Codex stop hook sees a hidden compaction drop", () => {
    const workspace = tempDir("codex-hooks-stop");
    const storePath = tempStorePath(workspace);
    const transcriptPath = path.join(workspace, "session.jsonl");
    const runtime = new TaskRecoveryRuntime({ dbPath: storePath, minTailEvents: 1 });
    runtime.createSession({
      id: "codex-session-3",
      provider: "custom",
      model: "codex",
      host: "codex",
      workspaceRoot: workspace
    });
    runtime.recordEvent({
      sessionId: "codex-session-3",
      kind: "plan_update",
      payload: {
        items: [{ id: "resume", text: "Resume from saved patch", status: "in_progress" }],
        nextAction: "Resume from saved patch"
      }
    });
    runtime.recordEvent({
      sessionId: "codex-session-3",
      kind: "host_event",
      payload: {
        host: "codex",
        hookEventName: "UserPromptSubmit",
        telemetryType: "token_count",
        telemetryTimestamp: "2026-04-21T00:10:00.000Z",
        transcriptPath,
        modelContextWindow: 258400,
        inputTokens: 210000,
        cachedInputTokens: 190000,
        outputTokens: 120,
        totalTokens: 210120,
        inputWindowFraction: 210000 / 258400,
        uncachedInputWindowFraction: 20000 / 258400
      }
    });
    runtime.createCheckpoint("codex-session-3", true);
    runtime.close();

    writeTranscript(transcriptPath, [
      {
        timestamp: "2026-04-21T00:11:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            model_context_window: 258400,
            last_token_usage: {
              input_tokens: 70000,
              cached_input_tokens: 60000,
              output_tokens: 220,
              total_tokens: 70220
            }
          }
        }
      }
    ]);

    const response = handleCodexHook(
      {
        session_id: "codex-session-3",
        hook_event_name: "Stop",
        transcript_path: transcriptPath,
        last_assistant_message: "I'll go back and reread the earlier files.",
        cwd: workspace
      },
      workspace
    ) as { decision?: string; reason?: string } | undefined;

    expect(response?.decision).toBe("block");
    expect(response?.reason).toContain("Resume from saved patch");
    expect(response?.reason).toContain("hidden compaction");

    const verifyRuntime = new TaskRecoveryRuntime({ dbPath: storePath });
    const events = verifyRuntime.listEvents("codex-session-3");
    expect(events.some((event) => event.kind === "compaction_detected")).toBe(true);
    expect(events.some((event) => event.kind === "resume_injected")).toBe(true);
    verifyRuntime.close();
  });
});
