import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  harvestLocalTraces,
  normalizeClaudeSession,
  normalizeCodexArchivedSession
} from "../src/host-importers";

const fixturesDir = path.resolve(__dirname, "fixtures");

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

describe("host importers", () => {
  test("normalizes a Codex archived session into a trace", () => {
    const trace = normalizeCodexArchivedSession(
      path.join(fixturesDir, "codex-session.jsonl"),
      { redact: false, traceId: "codex_001" }
    );

    expect(trace.session.provider).toBe("openai");
    expect(trace.session.model).toBe("gpt-5.4");
    expect(trace.events.some((event) => event.kind === "user_message")).toBe(true);
    expect(trace.events.some((event) => event.kind === "plan_update")).toBe(true);
    expect(trace.events.some((event) => event.kind === "command_exec")).toBe(true);
    expect(trace.events.some((event) => event.kind === "file_read")).toBe(true);
    expect(trace.expected?.nextAction).toBe("Patch token refresh logic");
  });

  test("normalizes a Claude session from history and todos", () => {
    const trace = normalizeClaudeSession(
      path.join(fixturesDir, "claude-history.jsonl"),
      path.join(fixturesDir, "claude-todos"),
      "claude-session-1",
      { redact: false, traceId: "claude_001" }
    );

    expect(trace.session.provider).toBe("anthropic");
    expect(trace.events.filter((event) => event.kind === "user_message")).toHaveLength(2);
    expect(trace.events.some((event) => event.kind === "plan_update")).toBe(true);
    expect(trace.expected?.nextAction).toBe("Patch token refresh logic");
  });

  test("harvests local traces from Codex and Claude homes", () => {
    const root = tempDir("harvest");
    const codexHome = path.join(root, ".codex");
    const claudeHome = path.join(root, ".claude");
    fs.mkdirSync(path.join(codexHome, "archived_sessions"), { recursive: true });
    fs.mkdirSync(path.join(claudeHome, "todos"), { recursive: true });

    fs.copyFileSync(
      path.join(fixturesDir, "codex-session.jsonl"),
      path.join(codexHome, "archived_sessions", "rollout-sample.jsonl")
    );
    fs.copyFileSync(
      path.join(fixturesDir, "claude-history.jsonl"),
      path.join(claudeHome, "history.jsonl")
    );
    fs.copyFileSync(
      path.join(fixturesDir, "claude-todos", "claude-session-1-agent-claude-session-1.json"),
      path.join(claudeHome, "todos", "claude-session-1-agent-claude-session-1.json")
    );

    process.env.CODEX_HOME = codexHome;
    const outDir = path.join(root, "out");
    const manifest = harvestLocalTraces({
      outDir,
      redact: false,
      maxCodexSessions: 1,
      maxClaudeSessions: 1
    });

    expect(manifest.entries).toHaveLength(2);
    expect(fs.existsSync(path.join(outDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "codex_001.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "claude_001.json"))).toBe(true);
  });
});
