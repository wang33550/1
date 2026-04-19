import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadTraceCorpus } from "../src/evals/corpus";
import { renderTraceCorpusEvalMarkdown } from "../src/evals/report";
import { runEval } from "../src/evals/runner";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe("trace corpus evaluation", () => {
  test("loads a normalized trace directory with manifest-aware filters", () => {
    const dir = tempDir("corpus");

    writeJson(path.join(dir, "codex-good.json"), {
      version: "trr_trace_v1",
      description: "Codex recovery trace",
      source: {
        host: "codex",
        traceId: "codex_good"
      },
      session: {
        provider: "openai",
        model: "gpt-5.4"
      },
      events: [
        {
          kind: "user_message",
          payload: {
            text: "Fix the auth flow"
          }
        },
        {
          kind: "decision",
          payload: {
            text: "Do not change schema"
          }
        },
        {
          kind: "file_write",
          payload: {
            path: "src/auth.ts",
            summary: "Patched auth refresh handling"
          }
        },
        {
          kind: "plan_update",
          payload: {
            items: [
              {
                id: "patch",
                text: "Patch auth refresh handling",
                status: "in_progress"
              }
            ],
            nextAction: "Patch auth refresh handling"
          }
        },
        {
          kind: "assistant_message",
          payload: {
            text: "Patch in progress"
          }
        }
      ],
      expected: {
        nextAction: "Patch auth refresh handling",
        requiredConstraints: ["Do not change schema"],
        requiredArtifacts: ["Patched auth refresh handling"]
      }
    });

    writeJson(path.join(dir, "claude-good.json"), {
      version: "trr_trace_v1",
      description: "Claude recovery trace",
      source: {
        host: "claude",
        traceId: "claude_good"
      },
      session: {
        provider: "anthropic",
        model: "claude-sonnet-4-5"
      },
      events: [
        {
          kind: "user_message",
          payload: {
            text: "Investigate pipeline stall"
          }
        },
        {
          kind: "user_message",
          payload: {
            text: "Keep timing behavior unchanged"
          }
        },
        {
          kind: "plan_update",
          payload: {
            items: [
              {
                id: "investigate",
                text: "Investigate handshake stall",
                status: "in_progress"
              }
            ],
            nextAction: "Investigate handshake stall"
          }
        },
        {
          kind: "assistant_message",
          payload: {
            text: "Investigating"
          }
        }
      ],
      expected: {
        nextAction: "Investigate handshake stall"
      }
    });

    writeJson(path.join(dir, "codex-no-next.json"), {
      version: "trr_trace_v1",
      description: "Missing next action trace",
      source: {
        host: "codex",
        traceId: "codex_no_next"
      },
      session: {
        provider: "openai",
        model: "gpt-5.4"
      },
      events: [
        {
          kind: "user_message",
          payload: {
            text: "Review the patch"
          }
        },
        {
          kind: "assistant_message",
          payload: {
            text: "Reviewing"
          }
        },
        {
          kind: "file_read",
          payload: {
            path: "src/review.ts"
          }
        }
      ],
      expected: {
        requiredConstraints: ["No schema changes"]
      }
    });

    writeJson(path.join(dir, "claude-short.json"), {
      version: "trr_trace_v1",
      description: "Too short trace",
      source: {
        host: "claude",
        traceId: "claude_short"
      },
      session: {
        provider: "anthropic",
        model: "claude-sonnet-4-5"
      },
      events: [
        {
          kind: "user_message",
          payload: {
            text: "Continue"
          }
        },
        {
          kind: "plan_update",
          payload: {
            items: [
              {
                id: "continue",
                text: "Continue debugging",
                status: "in_progress"
              }
            ],
            nextAction: "Continue debugging"
          }
        }
      ],
      expected: {
        nextAction: "Continue debugging"
      }
    });

    writeJson(path.join(dir, "manifest.json"), {
      generatedAt: "2026-04-19T00:00:00.000Z",
      outDir: dir,
      entries: [
        {
          id: "codex-good",
          host: "codex",
          quality: "high",
          outputPath: `out\\codex-good.json`
        },
        {
          id: "claude-good",
          host: "claude",
          quality: "medium",
          outputPath: `out\\claude-good.json`
        },
        {
          id: "codex-no-next",
          host: "codex",
          quality: "high",
          outputPath: `out\\codex-no-next.json`
        },
        {
          id: "claude-short",
          host: "claude",
          quality: "medium",
          outputPath: `out\\claude-short.json`
        }
      ],
      skipped: []
    });

    const corpus = loadTraceCorpus({
      dir,
      minEvents: 3,
      requireNextAction: true
    });

    expect(corpus.dataset.scenarios).toHaveLength(2);
    expect(corpus.summary.manifestFound).toBe(true);
    expect(corpus.summary.totalTraceFiles).toBe(4);
    expect(corpus.summary.validTraceFiles).toBe(4);
    expect(corpus.summary.tracesWithExpected).toBe(4);
    expect(corpus.summary.tracesWithNextAction).toBe(3);
    expect(corpus.summary.includedCount).toBe(2);
    expect(corpus.summary.skippedByReason["missing expected.nextAction"]).toBe(1);
    expect(corpus.summary.skippedByReason["below minEvents=3"]).toBe(1);
    expect(corpus.summary.includedByHost.codex).toBe(1);
    expect(corpus.summary.includedByHost.claude).toBe(1);
    expect(corpus.summary.includedByQuality.high).toBe(1);
    expect(corpus.summary.includedByQuality.medium).toBe(1);

    const report = runEval(corpus.dataset);
    const markdown = renderTraceCorpusEvalMarkdown(corpus, report);

    expect(report.scenarioCount).toBe(2);
    expect(markdown).toContain("# Trace Corpus Evaluation");
    expect(markdown).toContain("missing expected.nextAction");
    expect(markdown).toContain("below minEvents=3");
    expect(markdown).toContain("n/a");
  });
});
