import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { renderEvalMarkdown } from "../src/evals/report";
import { runEval } from "../src/evals/runner";
import { TaskRecoveryRuntime } from "../src/runtime";
import { importTrace, loadTraceFile, traceToEvalDataset, type TraceImportFile } from "../src/traces";

function tempFilePath(name: string): string {
  return path.join(os.tmpdir(), `trr-trace-${name}-${Date.now()}-${Math.random()}.json`);
}

function sampleTrace(): TraceImportFile {
  return {
    version: "trr_trace_v1",
    description: "Imported auth recovery trace",
    source: {
      host: "codex",
      traceId: "auth_imported_trace",
      exportedAt: "2026-04-19T12:00:00.000Z",
      exporter: "manual-test"
    },
    session: {
      provider: "custom",
      model: "test-model",
      workspaceRoot: "/workspace/demo"
    },
    minTailEvents: 2,
    checkpoint: {
      create: true,
      force: true
    },
    events: [
      {
        kind: "user_message",
        payload: {
          text: "Fix the flaky auth test without changing the database schema.",
          successCriteria: ["Auth tests pass", "No schema changes"]
        }
      },
      {
        kind: "decision",
        payload: {
          category: "constraint",
          text: "Do not modify database schema.",
          pinned: true
        }
      },
      {
        kind: "file_read",
        payload: {
          path: "src/auth/tokens.ts",
          startLine: 1,
          endLine: 80
        }
      },
      {
        kind: "plan_update",
        payload: {
          items: [
            { id: "inspect", text: "Inspect flaky auth test", status: "done" },
            { id: "patch", text: "Patch token refresh logic", status: "in_progress" },
            { id: "verify", text: "Run auth test suite", status: "pending" }
          ],
          nextAction: "Patch token refresh logic"
        }
      },
      {
        kind: "file_write",
        payload: {
          path: "src/auth/tokens.ts",
          summary: "Adjusted token refresh timing to avoid race conditions.",
          afterHash: "hash-1"
        }
      },
      {
        kind: "command_exec",
        payload: {
          command: "git push origin fix/auth-refresh",
          sideEffect: true,
          summary: "Pushed auth refresh fix"
        }
      }
    ],
    expected: {
      nextAction: "Patch token refresh logic",
      requiredConstraints: ["Do not modify database schema."],
      requiredArtifacts: ["Adjusted token refresh timing to avoid race conditions."],
      candidateActions: [
        {
          actionType: "file_read",
          path: "src/auth/tokens.ts",
          startLine: 1,
          endLine: 80
        }
      ],
      sideEffectActions: [
        {
          actionType: "command_exec",
          command: "git push origin fix/auth-refresh",
          sideEffect: true
        }
      ]
    }
  };
}

describe("trace import and replay", () => {
  test("imports a normalized trace and replays it through the evaluator", () => {
    const tracePath = tempFilePath("sample");
    const storePath = tempFilePath("store");
    fs.writeFileSync(tracePath, JSON.stringify(sampleTrace(), null, 2));

    const trace = loadTraceFile(tracePath);
    const runtime = new TaskRecoveryRuntime({ dbPath: storePath, minTailEvents: 2 });
    const imported = importTrace(runtime, trace);
    const resume = runtime.buildResumePacket(imported.sessionId);
    const dataset = traceToEvalDataset(trace);
    const report = runEval(dataset);
    const markdown = renderEvalMarkdown(report);

    expect(imported.importedEvents).toBe(6);
    expect(imported.checkpointCreated).toBe(true);
    expect(resume.packet).toContain("Patch token refresh logic");
    expect(markdown).toContain("auth_imported_trace");

    const aggregate = new Map(report.strategies.map((item) => [item.strategy, item]));
    expect(aggregate.get("runtime")?.nextActionCoverage.ratio).toBe(1);
    expect(aggregate.get("runtime")?.duplicateProtectionCoverage.ratio).toBe(1);
    expect(aggregate.get("runtime")?.sideEffectBlockCoverage.ratio).toBe(1);

    runtime.close();
    fs.rmSync(tracePath, { force: true });
    fs.rmSync(storePath, { force: true });
  });
});
