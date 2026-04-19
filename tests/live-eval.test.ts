import { describe, expect, test } from "vitest";

import { runLiveReplay } from "../src/live-eval";
import { traceToEvalDataset, type TraceImportFile } from "../src/traces";
import type { ModelAdapter } from "../src/types";

class StubAdapter implements ModelAdapter {
  async sendTurn() {
    return {
      text: JSON.stringify({
        nextAction: "Patch token refresh logic",
        constraints: ["Do not modify database schema."],
        artifacts: ["Adjusted token refresh timing to avoid race conditions."]
      }),
      raw: null
    };
  }
}

function sampleTrace(): TraceImportFile {
  return {
    version: "trr_trace_v1",
    description: "Imported auth recovery trace",
    session: {
      provider: "custom",
      model: "test-model",
      workspaceRoot: "/workspace/demo"
    },
    minTailEvents: 2,
    events: [
      {
        kind: "user_message",
        payload: {
          text: "Fix the flaky auth test without changing the database schema."
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
        kind: "plan_update",
        payload: {
          items: [
            { id: "patch", text: "Patch token refresh logic", status: "in_progress" }
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

describe("live replay", () => {
  test("scores model output against imported trace expectations", async () => {
    const dataset = traceToEvalDataset(sampleTrace());
    const report = await runLiveReplay(dataset, {
      model: "stub-model",
      adapter: new StubAdapter(),
      strategies: ["runtime"]
    });

    expect(report.strategies).toHaveLength(1);
    expect(report.strategies[0]?.nextActionCoverage.ratio).toBe(1);
    expect(report.strategies[0]?.constraintCoverage.ratio).toBe(1);
    expect(report.strategies[0]?.artifactCoverage.ratio).toBe(1);
    expect(report.strategies[0]?.sideEffectBlockCoverage.ratio).toBe(1);
  });
});
