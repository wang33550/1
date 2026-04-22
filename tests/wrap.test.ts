import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import { defaultConfig } from "../src/config";
import { TaskRecoveryRuntime } from "../src/runtime";
import { wrapHost } from "../src/wrap";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

function makeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

function makeCommand(basePath: string, commandName: string, stdoutText: string): void {
  makeExecutable(path.join(basePath, commandName), `#!/usr/bin/env bash\necho ${stdoutText}\n`);
  fs.writeFileSync(
    path.join(basePath, `${commandName}.cmd`),
    `@echo off\r\necho ${stdoutText}\r\n`
  );
}

function seedWorkspace(name: string): string {
  const workspace = tempDir(name);
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

describe("wrap host", () => {
  test("injects a resume packet after compaction and de-duplicates injections", async () => {
    const workspace = seedWorkspace("wrap-compaction");
    const dbPath = path.join(workspace, ".trr", "store.json");
    const config = defaultConfig(workspace);
    const originalMode = process.env.FAKE_AGENT_MODE;
    process.env.FAKE_AGENT_MODE = "compaction_twice";
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    input.end();

    const result = await wrapHost({
      host: "generic-pty",
      workspaceRoot: workspace,
      config,
      dbPath,
      passthroughArgs: [process.execPath, path.resolve(__dirname, "fixtures", "fake-agent.js")],
      stdio: {
        input,
        output,
        error
      }
    });

    expect(result.resumed).toBe(true);
    expect(result.exitCode).toBe(0);

    const runtime = new TaskRecoveryRuntime({ dbPath });
    const events = runtime.listEvents(result.sessionId);
    const resumeEvents = events.filter((event) => event.kind === "resume_injected");
    expect(resumeEvents).toHaveLength(1);
    expect(runtime.getLatestCheckpoint(result.sessionId)?.nextAction).toBe("Patch token refresh logic");
    runtime.close();
    process.env.FAKE_AGENT_MODE = originalMode;
  });

  test("warns on repeated soft commands and blocks repeated dangerous commands", async () => {
    const workspace = seedWorkspace("wrap-guard");
    const dbPath = path.join(workspace, ".trr", "store.json");
    const fakeBin = path.join(workspace, "fake-bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    makeCommand(fakeBin, "dangerous-cmd", "dangerous-ran");
    makeCommand(fakeBin, "vitest", "vitest-ran");

    const originalPath = process.env.PATH || "";
    const originalMode = process.env.FAKE_AGENT_MODE;
    process.env.PATH = [fakeBin, originalPath].join(path.delimiter);
    process.env.FAKE_AGENT_MODE = "guard";
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    let outputText = "";
    output.on("data", (chunk) => {
      outputText += chunk.toString("utf8");
    });
    let errorText = "";
    error.on("data", (chunk) => {
      errorText += chunk.toString("utf8");
    });
    input.end();

    const config = defaultConfig(workspace);
    config.guardPolicy.hardBlockCommandPrefixes.push("dangerous-cmd");
    await wrapHost({
      host: "generic-pty",
      workspaceRoot: workspace,
      config,
      dbPath,
      passthroughArgs: [process.execPath, path.resolve(__dirname, "fixtures", "fake-agent.js")],
      stdio: {
        input,
        output,
        error
      }
    });

    const runtime = new TaskRecoveryRuntime({ dbPath });
    const events = runtime.listEvents(runtime.listSessions()[0]!.id);
    const guardEvents = events.filter((event) => event.kind === "guard_decision");
    expect(guardEvents.some((event) => event.payload.decision === "block")).toBe(true);
    expect(guardEvents.some((event) => event.payload.decision === "warn")).toBe(true);
    expect(`${outputText}\n${errorText}`).toContain("TRR recovery packet");
    expect(`${outputText}\n${errorText}`).toContain("Patch token refresh logic");
    runtime.close();
    process.env.PATH = originalPath;
    process.env.FAKE_AGENT_MODE = originalMode;
  });

  test("restarts once after crash and injects recovery into the restarted process", async () => {
    const workspace = seedWorkspace("wrap-restart");
    const dbPath = path.join(workspace, ".trr", "store.json");
    const config = defaultConfig(workspace);
    const originalMode = process.env.FAKE_AGENT_MODE;
    process.env.FAKE_AGENT_MODE = "restart";
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    input.end();

    const result = await wrapHost({
      host: "generic-pty",
      workspaceRoot: workspace,
      config,
      dbPath,
      passthroughArgs: [process.execPath, path.resolve(__dirname, "fixtures", "fake-agent.js")],
      stdio: {
        input,
        output,
        error
      }
    });

    expect(result.restartCount).toBe(1);
    expect(result.resumed).toBe(true);

    const runtime = new TaskRecoveryRuntime({ dbPath });
    const events = runtime.listEvents(result.sessionId);
    expect(events.some((event) => event.kind === "process_restarted")).toBe(true);
    expect(events.some((event) => event.kind === "resume_injected")).toBe(true);
    runtime.close();
    process.env.FAKE_AGENT_MODE = originalMode;
  }, 10000);

  test("forwards stdin EOF to wrapped hosts that read prompts from stdin", async () => {
    const workspace = seedWorkspace("wrap-stdin-eof");
    const dbPath = path.join(workspace, ".trr", "store.json");
    const config = defaultConfig(workspace);
    const originalMode = process.env.FAKE_AGENT_MODE;
    process.env.FAKE_AGENT_MODE = "stdin_eof";
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    input.end("EOF_PROBE\n");

    const result = await wrapHost({
      host: "generic-pty",
      workspaceRoot: workspace,
      config,
      dbPath,
      passthroughArgs: [process.execPath, path.resolve(__dirname, "fixtures", "fake-agent.js")],
      stdio: {
        input,
        output,
        error
      }
    });

    expect(result.exitCode).toBe(0);
    expect(output.read()?.toString("utf8")).toContain("EOF_OK");
    process.env.FAKE_AGENT_MODE = originalMode;
  }, 10000);

  test("auto-bootstraps config and host hooks on first wrapped launch", async () => {
    const workspace = seedWorkspace("wrap-bootstrap");
    const dbPath = path.join(workspace, ".trr", "store.json");
    const fakeBin = path.join(workspace, "fake-bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    makeCommand(fakeBin, "claude", "claude-ready");
    makeCommand(fakeBin, "codex", "codex-ready");

    const originalPath = process.env.PATH || "";
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.PATH = [fakeBin, originalPath].join(path.delimiter);
    const codexHome = tempDir("wrap-bootstrap-codex-home");
    process.env.CODEX_HOME = codexHome;

    try {
      const config = defaultConfig(workspace);
      const claudeInput = new PassThrough();
      const claudeOutput = new PassThrough();
      const claudeError = new PassThrough();
      claudeInput.end();

      const claudeResult = await wrapHost({
        host: "claude",
        workspaceRoot: workspace,
        config,
        dbPath,
        stdio: {
          input: claudeInput,
          output: claudeOutput,
          error: claudeError
        }
      });

      expect(claudeResult.exitCode).toBe(0);
      expect(fs.existsSync(path.join(workspace, "trr.config.json"))).toBe(true);
      const claudeSettingsPath = path.join(workspace, ".claude", "settings.local.json");
      expect(fs.existsSync(claudeSettingsPath)).toBe(true);
      expect(fs.readFileSync(claudeSettingsPath, "utf8")).toContain("trr hook claude");

      const codexInput = new PassThrough();
      const codexOutput = new PassThrough();
      const codexError = new PassThrough();
      codexInput.end();

      const codexResult = await wrapHost({
        host: "codex",
        workspaceRoot: workspace,
        config,
        dbPath,
        stdio: {
          input: codexInput,
          output: codexOutput,
          error: codexError
        }
      });

      expect(codexResult.exitCode).toBe(0);
      const codexHooksPath = path.join(codexHome, "hooks.json");
      const codexConfigPath = path.join(codexHome, "config.toml");
      expect(fs.existsSync(codexHooksPath)).toBe(true);
      expect(fs.existsSync(codexConfigPath)).toBe(true);
      expect(fs.readFileSync(codexHooksPath, "utf8")).toContain("trr hook codex");
      expect(fs.readFileSync(codexConfigPath, "utf8")).toContain("codex_hooks = true");
    } finally {
      process.env.PATH = originalPath;
      process.env.CODEX_HOME = originalCodexHome;
    }
  });
});
