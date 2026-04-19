import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { TaskRecoveryRuntime } from "../src/runtime";

function tempStorePath(name: string): string {
  return path.join(os.tmpdir(), `trr-${name}-${Date.now()}-${Math.random()}.json`);
}

describe("TaskRecoveryRuntime", () => {
  test("creates a checkpoint with structured task state", () => {
    const storePath = tempStorePath("checkpoint");
    const runtime = new TaskRecoveryRuntime({ dbPath: storePath, minTailEvents: 1 });
    const session = runtime.createSession({
      provider: "custom",
      model: "test-model",
      workspaceRoot: "/workspace/demo"
    });

    runtime.recordEvent({
      sessionId: session.id,
      kind: "user_message",
      payload: {
        text: "Fix the flaky auth test without changing the database schema.",
        successCriteria: ["Auth tests pass", "No schema changes"]
      }
    });
    runtime.recordEvent({
      sessionId: session.id,
      kind: "decision",
      payload: {
        category: "constraint",
        text: "Do not modify database schema.",
        pinned: true
      }
    });
    runtime.recordEvent({
      sessionId: session.id,
      kind: "plan_update",
      payload: {
        items: [
          { id: "inspect", text: "Inspect flaky auth test", status: "done" },
          { id: "patch", text: "Patch token refresh logic", status: "in_progress" },
          { id: "verify", text: "Run auth test suite", status: "pending" }
        ],
        nextAction: "Patch token refresh logic"
      }
    });
    runtime.recordEvent({
      sessionId: session.id,
      kind: "file_write",
      payload: {
        path: "src/auth/tokens.ts",
        summary: "Adjusted token refresh timing to avoid race conditions.",
        afterHash: "hash-1"
      }
    });
    runtime.recordEvent({
      sessionId: session.id,
      kind: "command_exec",
      payload: {
        command: "vitest tests/auth/token-refresh.test.ts",
        exitCode: 0,
        summary: "1 test passed"
      }
    });

    const checkpoint = runtime.createCheckpoint(session.id, true);
    const resume = runtime.buildResumePacket(session.id);

    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.goal).toContain("Fix the flaky auth test");
    expect(checkpoint?.constraints[0]?.text).toContain("Do not modify database schema");
    expect(checkpoint?.pinnedMemory[0]?.text).toContain("Do not modify database schema");
    expect(checkpoint?.currentPlan).toHaveLength(3);
    expect(checkpoint?.nextAction).toBe("Patch token refresh logic");
    expect(checkpoint?.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(resume.packet).toContain("<RUNTIME>");
    expect(resume.packet).toContain("<CHECKPOINT>");
    expect(resume.packet).toContain("<PINNED_MEMORY>");
    expect(resume.packet).toContain("<FRONTIER_HINTS>");
    expect(resume.packet).toContain("<RECENT_FRONTIER>");
    expect(resume.packet).toContain("next_action: Patch token refresh logic");
    expect(resume.packet).not.toContain("<RUNTIME_CONTRACT");
    expect(resume.packet).not.toContain("pinned_memory:");

    runtime.close();
    fs.rmSync(storePath, { force: true });
  });

  test("resume packet promotes newer frontier next action over stale checkpoint fallback", () => {
    const storePath = tempStorePath("frontier-next-action");
    const runtime = new TaskRecoveryRuntime({ dbPath: storePath, minTailEvents: 2 });
    const session = runtime.createSession({
      provider: "custom",
      model: "test-model",
      workspaceRoot: "/workspace/demo"
    });

    runtime.recordEvent({
      sessionId: session.id,
      kind: "user_message",
      payload: {
        text: "Stabilize the release hotfix without changing the public API."
      }
    });
    runtime.recordEvent({
      sessionId: session.id,
      kind: "plan_update",
      payload: {
        items: [
          { id: "inspect", text: "Inspect the failing serializer path", status: "done" },
          { id: "patch", text: "Patch hotfix serializer", status: "in_progress" }
        ],
        nextAction: "Patch hotfix serializer"
      }
    });

    runtime.createCheckpoint(session.id, true);

    runtime.recordEvent({
      sessionId: session.id,
      kind: "plan_update",
      payload: {
        items: [
          { id: "inspect", text: "Inspect the failing serializer path", status: "done" },
          { id: "patch", text: "Patch hotfix serializer", status: "done" },
          { id: "verify", text: "Run serializer regression suite", status: "in_progress" }
        ],
        nextAction: "Run serializer regression suite"
      }
    });

    const resume = runtime.buildResumePacket(session.id);

    expect(resume.checkpoint?.nextAction).toBe("Run serializer regression suite");
    expect(resume.packet).toContain("next_action: Run serializer regression suite");

    runtime.close();
    fs.rmSync(storePath, { force: true });
  });

  test("repeat guard warns on duplicate reads and blocks repeated side effects", () => {
    const storePath = tempStorePath("guard");
    const runtime = new TaskRecoveryRuntime({ dbPath: storePath });
    const session = runtime.createSession({
      provider: "custom",
      model: "test-model"
    });

    runtime.recordEvent({
      sessionId: session.id,
      kind: "file_read",
      payload: {
        path: "/tmp/example.ts",
        startLine: 1,
        endLine: 20
      }
    });
    runtime.recordEvent({
      sessionId: session.id,
      kind: "command_exec",
      payload: {
        command: "git push origin main",
        sideEffect: true,
        summary: "Pushed changes"
      }
    });

    const readCheck = runtime.assessAction(session.id, {
      actionType: "file_read",
      path: "/tmp/example.ts",
      startLine: 1,
      endLine: 20
    });
    const pushCheck = runtime.assessAction(session.id, {
      actionType: "command_exec",
      command: "git push origin main",
      sideEffect: true
    });

    expect(readCheck.decision).toBe("warn");
    expect(pushCheck.decision).toBe("block");

    runtime.close();
    fs.rmSync(storePath, { force: true });
  });
});
