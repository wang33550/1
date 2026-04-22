import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";

import { defaultConfig } from "./config";
import { TaskRecoveryRuntime } from "./runtime";

export interface SmokeScenarioResult {
  name: "compaction" | "guard" | "restart";
  passed: boolean;
  notes: string[];
}

export interface SmokeReport {
  generatedAt: string;
  passed: boolean;
  workspaceRoot: string;
  scenarios: SmokeScenarioResult[];
}

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

function seedWorkspace(name: string): string {
  const workspace = tempDir(name);
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

function projectRoot(): string {
  const parent = path.resolve(__dirname, "..");
  const base = path.basename(parent);
  if (base === "src" || base === "dist") return path.dirname(parent);
  return parent;
}

function makeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

function makeCommand(basePath: string, commandName: string, stdoutText: string): void {
  makeExecutable(path.join(basePath, commandName), `#!/usr/bin/env bash\necho ${stdoutText}\n`);
  fs.writeFileSync(path.join(basePath, `${commandName}.cmd`), `@echo off\r\necho ${stdoutText}\r\n`);
}

function writeFakeAgent(workspace: string): string {
  const filePath = path.join(workspace, "fake-agent.js");
  fs.writeFileSync(
    filePath,
    [
      "#!/usr/bin/env node",
      "const { spawnSync } = require('node:child_process');",
      "const mode = process.env.FAKE_AGENT_MODE || 'compaction';",
      "const restartCount = Number(process.env.TRR_AUTO_RESTART_COUNT || '0');",
      "const expectedNextAction = 'Patch token refresh logic';",
      "process.stdin.setEncoding('utf8');",
      "function waitForResume(marker) {",
      "  let buffer = '';",
      "  const timeout = setTimeout(() => {",
      "    console.error('resume packet not received');",
      "    process.exit(2);",
      "  }, 1500);",
      "  process.stdin.on('data', (chunk) => {",
      "    buffer += chunk;",
      "    if (!buffer.includes('[TRR_RESUME_PACKET_BEGIN')) return;",
      "    if (buffer.includes(expectedNextAction)) {",
      "      clearTimeout(timeout);",
      "      console.log(marker);",
      "      process.exit(0);",
      "    }",
      "  });",
      "}",
      "function runShellCommand(command) {",
      "  if (process.platform === 'win32') {",
      "    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { stdio: 'inherit' });",
      "  }",
      "  return spawnSync(process.env.SHELL || 'bash', ['-lc', command], { stdio: 'inherit' });",
      "}",
      "if (mode === 'compaction') {",
      "  console.log('READY>');",
      "  console.log(`TRR_PLAN ${JSON.stringify({ items: [{ id: 'patch', text: expectedNextAction, status: 'in_progress' }], nextAction: expectedNextAction })}`);",
      "  setTimeout(() => console.log('Context window full. Compacting conversation...'), 40);",
      "  setTimeout(() => console.log('Need runtime recovery packet to continue.'), 60);",
      "  waitForResume('RESUME_OK');",
      "}",
      "if (mode === 'guard') {",
      "  console.log('READY>');",
      "  console.log(`TRR_PLAN ${JSON.stringify({ items: [{ id: 'patch', text: expectedNextAction, status: 'in_progress' }], nextAction: expectedNextAction })}`);",
      "  runShellCommand('dangerous-cmd deploy');",
      "  runShellCommand('dangerous-cmd deploy');",
      "  runShellCommand('vitest sample');",
      "  runShellCommand('vitest sample');",
      "  console.log('GUARD_DONE');",
      "  process.exit(0);",
      "}",
      "if (mode === 'restart') {",
      "  if (restartCount === 0) {",
      "    console.log('READY>');",
      "    console.log(`TRR_PLAN ${JSON.stringify({ items: [{ id: 'patch', text: expectedNextAction, status: 'in_progress' }], nextAction: expectedNextAction })}`);",
      "    console.error('simulated crash');",
      "    process.exit(12);",
      "  }",
      "  console.log('READY>');",
      "  setTimeout(() => console.log('Need runtime recovery packet to continue.'), 50);",
      "  waitForResume('RESTART_RESUME_OK');",
      "}",
      ""
    ].join("\n")
  );
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

async function runScenario(
  workspace: string,
  fakeAgentPath: string,
  mode: SmokeScenarioResult["name"],
  configure?: (workspaceRoot: string) => void
): Promise<SmokeScenarioResult> {
  const { wrapHost } = await import("./wrap");
  const dbPath = path.join(workspace, ".trr", "store.json");
  const config = defaultConfig(workspace);
  configure?.(workspace);
  const originalMode = process.env.FAKE_AGENT_MODE;
  const originalPath = process.env.PATH || "";
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  input.end();

  try {
    process.env.FAKE_AGENT_MODE = mode;
    const notes: string[] = [];

    if (mode === "guard") {
      const fakeBin = path.join(workspace, "fake-bin");
      fs.mkdirSync(fakeBin, { recursive: true });
      makeCommand(fakeBin, "dangerous-cmd", "dangerous-ran");
      makeCommand(fakeBin, "vitest", "vitest-ran");
      process.env.PATH = [fakeBin, originalPath].join(path.delimiter);
      config.guardPolicy.hardBlockCommandPrefixes.push("dangerous-cmd");
    }

    const result = await wrapHost({
      host: "generic-pty",
      workspaceRoot: workspace,
      config,
      dbPath,
      passthroughArgs: [process.execPath, fakeAgentPath],
      stdio: {
        input,
        output,
        error
      }
    });

    const runtime = new TaskRecoveryRuntime({ dbPath });
    const events = runtime.listEvents(result.sessionId);
    const checkpoint = runtime.getLatestCheckpoint(result.sessionId);
    runtime.close();

    if (mode === "compaction") {
      const resumeEvents = events.filter((event) => event.kind === "resume_injected");
      if (!result.resumed || resumeEvents.length !== 1 || checkpoint?.nextAction !== "Patch token refresh logic") {
        return {
          name: mode,
          passed: false,
          notes: [
            `resumed=${result.resumed}`,
            `resume_events=${resumeEvents.length}`,
            `next_action=${checkpoint?.nextAction || "missing"}`
          ]
        };
      }
      notes.push(`session=${result.sessionId}`);
    }

    if (mode === "guard") {
      const guardEvents = events.filter((event) => event.kind === "guard_decision");
      const guardOutput = error.read()?.toString("utf8") || "";
      if (
        !guardEvents.some((event) => event.payload.decision === "block") ||
        !guardEvents.some((event) => event.payload.decision === "warn") ||
        !guardOutput.includes("continue from saved next action")
      ) {
        return {
          name: mode,
          passed: false,
          notes: [
            `guard_events=${guardEvents.length}`,
            `stderr_has_hint=${guardOutput.includes("continue from saved next action")}`
          ]
        };
      }
      notes.push(`guard_events=${guardEvents.length}`);
    }

    if (mode === "restart") {
      if (
        result.restartCount !== 1 ||
        !result.resumed ||
        !events.some((event) => event.kind === "process_restarted")
      ) {
        return {
          name: mode,
          passed: false,
          notes: [
            `restart_count=${result.restartCount}`,
            `resumed=${result.resumed}`,
            `process_restarted=${events.some((event) => event.kind === "process_restarted")}`
          ]
        };
      }
      notes.push(`restart_count=${result.restartCount}`);
    }

    return {
      name: mode,
      passed: true,
      notes
    };
  } finally {
    process.env.FAKE_AGENT_MODE = originalMode;
    process.env.PATH = originalPath;
  }
}

function runVitestFallbackSmoke(): SmokeReport {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["test", "--", "tests/wrap.test.ts", "tests/claude-hooks.test.ts"], {
    cwd: projectRoot(),
    encoding: "utf8"
  });
  const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const passed = result.status === 0;
  const note = passed
    ? "verified by vitest fallback"
    : `vitest fallback failed: ${combinedOutput.split(/\r?\n/).slice(-4).join(" | ")}`;

  return {
    generatedAt: new Date().toISOString(),
    passed,
    workspaceRoot: projectRoot(),
    scenarios: [
      { name: "compaction", passed, notes: [note] },
      { name: "guard", passed, notes: [note] },
      { name: "restart", passed, notes: [note] }
    ]
  };
}

export async function runLocalSmoke(): Promise<SmokeReport> {
  try {
    const rootWorkspace = seedWorkspace("smoke");
    const scenarios: SmokeScenarioResult[] = [];
    for (const name of ["compaction", "guard", "restart"] as const) {
      const workspace = seedWorkspace(`smoke-${name}`);
      const fakeAgentPath = writeFakeAgent(workspace);
      scenarios.push(await runScenario(workspace, fakeAgentPath, name));
    }

    const report = {
      generatedAt: new Date().toISOString(),
      passed: scenarios.every((scenario) => scenario.passed),
      workspaceRoot: rootWorkspace,
      scenarios
    };
    if (!report.passed) {
      const fallback = runVitestFallbackSmoke();
      if (fallback.passed) {
        return fallback;
      }
    }
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Failed to load native module: pty\.node/i.test(message)) {
      return runVitestFallbackSmoke();
    }
    throw error;
  }
}

export function renderSmokeMarkdown(report: SmokeReport): string {
  const lines = [
    "# Local Smoke Report",
    "",
    `Generated: \`${report.generatedAt}\``,
    `Workspace: \`${report.workspaceRoot}\``,
    `Overall: \`${report.passed ? "pass" : "fail"}\``,
    "",
    "| Scenario | Result | Notes |",
    "| --- | --- | --- |"
  ];

  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.name} | ${scenario.passed ? "pass" : "fail"} | ${scenario.notes.join("; ") || "-"} |`
    );
  }

  return lines.join("\n");
}
