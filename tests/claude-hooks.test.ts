import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { handleClaudeHook, installClaudeHooks } from "../src/claude-hooks";
import { TaskRecoveryRuntime } from "../src/runtime";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

function tempStorePath(workspace: string): string {
  return path.join(workspace, ".trr", "trr-store.json");
}

describe("claude hooks", () => {
  test("installs workspace-local Claude hooks idempotently", () => {
    const workspace = tempDir("claude-hooks-install");

    const first = installClaudeHooks(workspace);
    const second = installClaudeHooks(workspace);
    const settings = JSON.parse(fs.readFileSync(first.settingsPath, "utf8")) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.command).toBe("trr hook claude");
    expect(settings.hooks?.SessionStart?.[0]?.matcher).toBe("startup|resume|compact");
    expect(settings.hooks?.PreCompact?.[0]?.hooks[0]?.command).toBe("trr hook claude");
  });

  test("injects saved recovery state on Claude compact session start", () => {
    const workspace = tempDir("claude-hooks-session-start");
    const storePath = tempStorePath(workspace);
    const runtime = new TaskRecoveryRuntime({ dbPath: storePath, minTailEvents: 1 });
    runtime.createSession({
      id: "claude-session-1",
      provider: "anthropic",
      model: "claude-sonnet",
      host: "claude",
      workspaceRoot: workspace
    });
    runtime.recordEvent({
      sessionId: "claude-session-1",
      kind: "user_message",
      payload: {
        text: "Fix the refresh token bug."
      }
    });
    runtime.recordEvent({
      sessionId: "claude-session-1",
      kind: "plan_update",
      payload: {
        items: [{ id: "patch", text: "Patch token refresh logic", status: "in_progress" }],
        nextAction: "Patch token refresh logic"
      }
    });
    runtime.createCheckpoint("claude-session-1", true);
    runtime.close();

    const response = handleClaudeHook(
      {
        session_id: "claude-session-1",
        hook_event_name: "SessionStart",
        source: "compact",
        model: "claude-sonnet",
        cwd: workspace
      },
      workspace
    );

    expect(response).toBeTruthy();
    expect(
      (response?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext
    ).toContain("Patch token refresh logic");

    const verifyRuntime = new TaskRecoveryRuntime({ dbPath: storePath });
    const events = verifyRuntime.listEvents("claude-session-1");
    expect(events.some((event) => event.kind === "resume_injected")).toBe(true);
    verifyRuntime.close();
  });

  test("returns Claude hook permission feedback for repeated dangerous commands", () => {
    const workspace = tempDir("claude-hooks-guard");
    const storePath = tempStorePath(workspace);
    const runtime = new TaskRecoveryRuntime({ dbPath: storePath, minTailEvents: 1 });
    runtime.createSession({
      id: "claude-session-2",
      provider: "anthropic",
      model: "claude-sonnet",
      host: "claude",
      workspaceRoot: workspace
    });
    runtime.recordEvent({
      sessionId: "claude-session-2",
      kind: "plan_update",
      payload: {
        items: [{ id: "push", text: "Push release branch once checks pass", status: "pending" }],
        nextAction: "Push release branch once checks pass"
      }
    });
    runtime.recordEvent({
      sessionId: "claude-session-2",
      kind: "command_exec",
      payload: {
        command: "git push origin main",
        cwd: workspace,
        sideEffect: true,
        summary: "pushed once"
      }
    });
    runtime.createCheckpoint("claude-session-2", true);
    runtime.close();

    const response = handleClaudeHook(
      {
        session_id: "claude-session-2",
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
    expect(
      (response?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext
    ).toContain("Push release branch once checks pass");
  });
});
