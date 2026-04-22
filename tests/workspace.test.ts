import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import { captureWorkspaceSnapshot } from "../src/workspace";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

describe("workspace snapshot", () => {
  test("captures git status and diff", () => {
    const workspace = tempDir("workspace");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "hello\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=TRR", "-c", "user.email=trr@example.com", "commit", "-m", "init"], {
      cwd: workspace,
      stdio: "ignore"
    });
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "hello\nworld\n");
    fs.writeFileSync(path.join(workspace, "file.txt"), "hello\n");

    const snapshot = captureWorkspaceSnapshot(workspace);
    expect(snapshot.workspaceRoot).toBe(workspace);
    expect(snapshot.modifiedFiles).toContain("file.txt");
    expect(snapshot.modifiedFiles).toContain("tracked.txt");
  });
});
