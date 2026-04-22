import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { WorkspaceSnapshot } from "./types";
import { nowIso, normalizeWhitespace } from "./utils";

function runGit(workspaceRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return "";
  }
}

function nonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
}

function modifiedFilesFromStatus(lines: string[]): string[] {
  return lines
    .map((line) => {
      const match = normalizeWhitespace(line).match(/^[A-Z?!]{1,2}\s+(.+)$/i);
      return normalizeWhitespace(match?.[1] || "");
    })
    .filter(Boolean)
    .slice(0, 12);
}

function recentTestResults(workspaceRoot: string): string[] {
  const candidates = [
    path.join(workspaceRoot, ".tmp", "reports", "real-trace-corpus.md"),
    path.join(workspaceRoot, ".tmp", "reports", "real-trace-codex-only.md")
  ];
  const results: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const firstLine = nonEmptyLines(fs.readFileSync(candidate, "utf8"))[0];
    if (firstLine) results.push(`${path.basename(candidate)}: ${firstLine}`);
  }
  return results;
}

export function captureWorkspaceSnapshot(workspaceRoot: string): WorkspaceSnapshot {
  const gitStatusShort = nonEmptyLines(runGit(workspaceRoot, ["status", "--short"]));
  const gitDiffStat = nonEmptyLines(runGit(workspaceRoot, ["diff", "--stat"]));
  return {
    workspaceRoot,
    capturedAt: nowIso(),
    gitStatusShort,
    gitDiffStat,
    modifiedFiles: modifiedFilesFromStatus(gitStatusShort),
    recentTestResults: recentTestResults(workspaceRoot)
  };
}
