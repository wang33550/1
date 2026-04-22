import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  detectShellName,
  ensureShellIntegrationScript,
  installShellIntegration,
  renderShellActivation
} from "../src/shell-integration";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

describe("shell integration", () => {
  test("renders activation snippets for supported shells", () => {
    expect(renderShellActivation("bash")).toContain('codex() { command trr wrap codex -- "$@"; }');
    expect(renderShellActivation("fish")).toContain("function claude");
    expect(renderShellActivation("powershell")).toContain("function codex { trr wrap codex -- @args }");
    expect(detectShellName("pwsh")).toBe("powershell");

    const direct = renderShellActivation("bash", {
      nodeExecutable: "/usr/bin/node",
      cliEntry: "/tmp/trr/dist/cli.js",
      platform: "linux",
      source: "current_process",
      ptyReady: true
    });
    expect(direct).toContain("command '/usr/bin/node' '/tmp/trr/dist/cli.js' wrap codex --");

    const windowsLauncher = renderShellActivation("bash", {
      nodeExecutable: "/mnt/e/Node/node.exe",
      cliEntry: "C:\\repo\\dist\\cli.js",
      platform: "win32",
      source: "npm_sibling",
      ptyReady: true
    });
    expect(windowsLauncher).toContain('wrap --workspace-root "$_trr_workspace" codex -- "$@"');
  });

  test("installs shell integration idempotently", () => {
    const workspace = tempDir("shell");
    const rcFilePath = path.join(workspace, ".bashrc");

    const first = installShellIntegration(workspace, "bash", rcFilePath);
    const second = installShellIntegration(workspace, "bash", rcFilePath);
    const rcContent = fs.readFileSync(rcFilePath, "utf8");
    const scriptContent = fs.readFileSync(first.scriptPath, "utf8");

    expect(first.rcFilePath).toBe(rcFilePath);
    expect(second.rcFilePath).toBe(rcFilePath);
    expect(scriptContent).toContain("wrap --workspace-root");
    expect(rcContent.match(/trr shell integration/g)?.length).toBe(2);
    expect(ensureShellIntegrationScript(workspace, "bash")).toBe(first.scriptPath);
  });
});
