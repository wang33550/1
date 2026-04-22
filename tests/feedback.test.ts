import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadConfig, writeDefaultConfig } from "../src/config";
import {
  buildFeedbackBundle,
  resolveFeedbackSession,
  writeFeedbackBundle
} from "../src/feedback";
import { TaskRecoveryRuntime } from "../src/runtime";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

describe("feedback export", () => {
  test("exports a redacted feedback bundle for the latest workspace session", () => {
    const workspace = tempDir("feedback-redacted");
    writeDefaultConfig(workspace);
    const config = loadConfig(workspace);
    const dbPath = path.join(workspace, ".trr", "store.json");
    const runtime = new TaskRecoveryRuntime({ dbPath });

    try {
      const session = runtime.createSession({
        provider: "anthropic",
        model: "claude-opus-4-6",
        host: "claude",
        workspaceRoot: workspace
      });

      runtime.recordEvent({
        sessionId: session.id,
        kind: "user_message",
        payload: {
          text: `排查 ${workspace} 中的 token 漂移问题，并使用 sk-abc123secret 连接测试环境`
        }
      });
      runtime.recordEvent({
        sessionId: session.id,
        kind: "plan_update",
        payload: {
          nextAction: `检查 ${workspace} 下的压缩后恢复日志`,
          items: [
            { id: "inspect", text: "检查恢复日志", status: "in_progress" },
            { id: "guard", text: "确认重复执行保护", status: "pending" }
          ]
        }
      });
      runtime.recordEvent({
        sessionId: session.id,
        kind: "command_exec",
        payload: {
          command: `curl https://api.example.com -H "Authorization: Bearer testtoken123"`,
          cwd: workspace,
          exitCode: 0,
          sideEffect: true,
          summary: `在 ${workspace} 中执行了带鉴权头的外发请求`
        }
      });
      runtime.recordEvent({
        sessionId: session.id,
        kind: "guard_decision",
        payload: {
          decision: "block",
          actionType: "command_exec",
          command: "git push origin main",
          reason: "重复危险命令已被阻止"
        }
      });
      runtime.recordEvent({
        sessionId: session.id,
        kind: "compaction_detected",
        payload: {
          host: "claude",
          reason: `模型在 ${workspace} 中触发自动压缩`
        }
      });
      runtime.createCheckpoint(session.id, true);

      const latest = resolveFeedbackSession(runtime, workspace, undefined, "claude");
      expect(latest.id).toBe(session.id);

      const result = writeFeedbackBundle(runtime, config, session, {
        label: "failure",
        notes: "真实环境中观察到自动压缩后需要人工确认一次",
        trrVersion: "0.1.2"
      });

      expect(fs.existsSync(result.outputPath)).toBe(true);
      expect(result.bundle.redacted).toBe(true);
      expect(result.bundle.session.workspaceRoot).toBe("$WORKSPACE");
      expect(result.bundle.source.workspaceRoot).toBe("$WORKSPACE");
      expect(JSON.stringify(result.bundle)).toContain("[REDACTED_API_KEY]");
      expect(JSON.stringify(result.bundle)).toContain("Bearer [REDACTED]");
      expect(result.bundle.summary.compactionCount).toBe(1);
      expect(result.bundle.summary.guardBlockCount).toBe(1);
      expect(result.bundle.summary.nextAction).toContain("$WORKSPACE");
      expect(result.bundle.currentResumePacket?.packet).toContain("$WORKSPACE");
    } finally {
      runtime.close();
    }
  });

  test("can build a non-redacted bundle when explicitly requested", () => {
    const workspace = tempDir("feedback-raw");
    writeDefaultConfig(workspace);
    const config = loadConfig(workspace);
    const dbPath = path.join(workspace, ".trr", "store.json");
    const runtime = new TaskRecoveryRuntime({ dbPath });

    try {
      const session = runtime.createSession({
        provider: "openai",
        model: "codex",
        host: "codex",
        workspaceRoot: workspace
      });

      runtime.recordEvent({
        sessionId: session.id,
        kind: "user_message",
        payload: {
          text: `检查 ${workspace} 的恢复包`
        }
      });
      runtime.createCheckpoint(session.id, true);

      const bundle = buildFeedbackBundle(runtime, config, session, {
        redact: false,
        trrVersion: "0.1.2"
      });

      expect(bundle.redacted).toBe(false);
      expect(bundle.session.workspaceRoot).toBe(workspace);
      expect(bundle.source.workspaceRoot).toBe(workspace);
      expect(bundle.currentResumePacket?.packet).toContain(workspace);
    } finally {
      runtime.close();
    }
  });
});
