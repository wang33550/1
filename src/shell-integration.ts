import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type SupportedShell = "bash" | "zsh" | "fish" | "powershell";

export interface ShellLauncher {
  nodeExecutable: string;
  cliEntry: string;
  platform: string;
  source: "current_process" | "npm_sibling" | "fallback";
  ptyReady: boolean;
}

const SHELL_MARKER_START = "# >>> trr shell integration >>>";
const SHELL_MARKER_END = "# <<< trr shell integration <<<";

function normalizeShellName(input: string): SupportedShell {
  const value = input.toLowerCase();
  if (value.includes("powershell") || value.includes("pwsh")) return "powershell";
  if (value.includes("fish")) return "fish";
  if (value.includes("zsh")) return "zsh";
  return "bash";
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellQuote(shell: SupportedShell, value: string): string {
  return shell === "powershell" ? powershellSingleQuote(value) : posixSingleQuote(value);
}

function shellScriptExtension(shell: SupportedShell): string {
  if (shell === "powershell") return "ps1";
  if (shell === "fish") return "fish";
  return shell;
}

function isExecutable(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(commandName: string): string | undefined {
  for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, commandName);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function detectNodePlatform(nodeExecutable: string): string | undefined {
  try {
    return execFileSync(nodeExecutable, ["-p", "process.platform"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

function canLoadNodePty(nodeExecutable: string, workspaceRoot: string): boolean {
  try {
    const output = execFileSync(nodeExecutable, ["-e", "require('node-pty');process.stdout.write('ok')"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.trim() === "ok";
  } catch {
    return false;
  }
}

function wslPathToWindows(targetPath: string): string {
  const match = targetPath.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!match) return targetPath;
  return `${match[1]!.toUpperCase()}:\\${match[2]!.replace(/\//g, "\\")}`;
}

function adaptCliEntryForPlatform(cliEntry: string, platformName: string | undefined): string {
  if (platformName === "win32") {
    return wslPathToWindows(cliEntry);
  }
  return cliEntry;
}

function npmSiblingNodeExecutable(): string | undefined {
  const envNode = process.env.npm_node_execpath;
  if (envNode && isExecutable(envNode)) return envNode;

  const npmExecutable = findExecutableOnPath(process.platform === "win32" ? "npm.cmd" : "npm");
  if (!npmExecutable) return undefined;
  const baseDir = path.dirname(npmExecutable);
  for (const candidate of [path.join(baseDir, "node.exe"), path.join(baseDir, "node")]) {
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function resolveCliEntry(workspaceRoot: string): string {
  const argvEntry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const base = path.basename(argvEntry).toLowerCase();
  if (base === "cli.js" || base === "cli.ts") {
    return argvEntry;
  }

  const distEntry = path.join(workspaceRoot, "dist", "cli.js");
  if (fs.existsSync(distEntry)) return distEntry;

  const sourceEntry = path.join(workspaceRoot, "src", "cli.ts");
  if (fs.existsSync(sourceEntry)) return sourceEntry;

  return path.resolve(workspaceRoot, "dist", "cli.js");
}

export function resolveShellLauncher(workspaceRoot: string): ShellLauncher {
  const cliEntry = resolveCliEntry(workspaceRoot);
  const candidates: Array<{ nodeExecutable: string; source: ShellLauncher["source"] }> = [];

  if (isExecutable(process.execPath)) {
    candidates.push({ nodeExecutable: process.execPath, source: "current_process" });
  }

  const npmNode = npmSiblingNodeExecutable();
  if (npmNode && !candidates.some((candidate) => candidate.nodeExecutable === npmNode)) {
    candidates.push({ nodeExecutable: npmNode, source: "npm_sibling" });
  }

  for (const candidate of candidates) {
    const platformName = detectNodePlatform(candidate.nodeExecutable) || process.platform;
    const ready = canLoadNodePty(candidate.nodeExecutable, workspaceRoot);
    if (ready) {
      return {
        nodeExecutable: candidate.nodeExecutable,
        cliEntry: adaptCliEntryForPlatform(cliEntry, platformName),
        platform: platformName,
        source: candidate.source,
        ptyReady: true
      };
    }
  }

  const platformName = detectNodePlatform(process.execPath) || process.platform;
  return {
    nodeExecutable: process.execPath,
    cliEntry: adaptCliEntryForPlatform(cliEntry, platformName),
    platform: platformName,
    source: "fallback",
    ptyReady: false
  };
}

function shellInstallSnippet(shell: SupportedShell, scriptPath: string): string {
  const quoted = shellQuote(shell, scriptPath);
  if (shell === "powershell") {
    return [SHELL_MARKER_START, `if (Test-Path ${quoted}) { . ${quoted} }`, SHELL_MARKER_END, ""].join("\n");
  }
  if (shell === "fish") {
    return [SHELL_MARKER_START, `if test -f ${quoted}`, `  source ${quoted}`, "end", SHELL_MARKER_END, ""].join(
      "\n"
    );
  }
  return [SHELL_MARKER_START, `[ -f ${quoted} ] && source ${quoted}`, SHELL_MARKER_END, ""].join("\n");
}

export function detectShellName(explicit?: string): SupportedShell {
  if (explicit) return normalizeShellName(explicit);
  if (process.env.SHELL) return normalizeShellName(path.basename(process.env.SHELL));
  if (process.env.ComSpec?.toLowerCase().includes("powershell")) return "powershell";
  return process.platform === "win32" ? "powershell" : "bash";
}

export function shellIntegrationDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".trr", "shell");
}

export function shellIntegrationScriptPath(workspaceRoot: string, shell: SupportedShell): string {
  return path.join(shellIntegrationDir(workspaceRoot), `trr.${shellScriptExtension(shell)}`);
}

export function renderShellActivation(shell: SupportedShell, launcher?: ShellLauncher): string {
  const nodeInvocation =
    launcher
      ? {
          node: shellQuote(shell, launcher.nodeExecutable),
          cli: shellQuote(shell, launcher.cliEntry)
        }
      : undefined;
  const useWindowsWorkspaceOverride = launcher?.platform === "win32";

  if (shell === "powershell") {
    const codexLine = launcher
      ? useWindowsWorkspaceOverride
        ? `function codex { & ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap --workspace-root $PWD.Path codex -- @args }`
        : `function codex { & ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap codex -- @args }`
      : "function codex { trr wrap codex -- @args }";
    const claudeLine = launcher
      ? useWindowsWorkspaceOverride
        ? `function claude { & ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap --workspace-root $PWD.Path claude -- @args }`
        : `function claude { & ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap claude -- @args }`
      : "function claude { trr wrap claude -- @args }";
    return [
      "$env:TRR_SHELL_INTEGRATION = '1'",
      codexLine,
      claudeLine,
      ""
    ].join("\n");
  }
  if (shell === "fish") {
    const codexLines = launcher
      ? useWindowsWorkspaceOverride
        ? [
            "  set -l _trr_workspace $PWD",
            "  if command -sq wslpath",
            "    set _trr_workspace (wslpath -w $PWD)",
            "  end",
            `  ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap --workspace-root "$_trr_workspace" codex -- $argv`
          ]
        : [`  ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap codex -- $argv`]
      : ["  trr wrap codex -- $argv"];
    const claudeLines = launcher
      ? useWindowsWorkspaceOverride
        ? [
            "  set -l _trr_workspace $PWD",
            "  if command -sq wslpath",
            "    set _trr_workspace (wslpath -w $PWD)",
            "  end",
            `  ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap --workspace-root "$_trr_workspace" claude -- $argv`
          ]
        : [`  ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap claude -- $argv`]
      : ["  trr wrap claude -- $argv"];
    return [
      "set -gx TRR_SHELL_INTEGRATION 1",
      "function codex",
      ...codexLines,
      "end",
      "function claude",
      ...claudeLines,
      "end",
      ""
    ].join("\n");
  }
  const codexLine = launcher
    ? useWindowsWorkspaceOverride
      ? [
          "codex() {",
          '  local _trr_workspace="$PWD";',
          "  if command -v wslpath >/dev/null 2>&1; then",
          '    _trr_workspace="$(wslpath -w "$PWD")";',
          "  fi",
          `  command ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap --workspace-root "$_trr_workspace" codex -- "$@";`,
          "}"
        ].join("\n")
      : `codex() { command ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap codex -- "$@"; }`
    : 'codex() { command trr wrap codex -- "$@"; }';
  const claudeLine = launcher
    ? useWindowsWorkspaceOverride
      ? [
          "claude() {",
          '  local _trr_workspace="$PWD";',
          "  if command -v wslpath >/dev/null 2>&1; then",
          '    _trr_workspace="$(wslpath -w "$PWD")";',
          "  fi",
          `  command ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap --workspace-root "$_trr_workspace" claude -- "$@";`,
          "}"
        ].join("\n")
      : `claude() { command ${nodeInvocation!.node} ${nodeInvocation!.cli} wrap claude -- "$@"; }`
    : 'claude() { command trr wrap claude -- "$@"; }';
  return [
    "export TRR_SHELL_INTEGRATION=1",
    codexLine,
    claudeLine,
    ""
  ].join("\n");
}

export function ensureShellIntegrationScript(
  workspaceRoot: string,
  shell: SupportedShell,
  launcher = resolveShellLauncher(workspaceRoot)
): string {
  const dir = shellIntegrationDir(workspaceRoot);
  const scriptPath = shellIntegrationScriptPath(workspaceRoot, shell);
  fs.mkdirSync(dir, { recursive: true });
  const content = renderShellActivation(shell, launcher);
  if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, "utf8") !== content) {
    fs.writeFileSync(scriptPath, content);
  }
  return scriptPath;
}

export function defaultRcFilePath(shell: SupportedShell, homeDir = os.homedir()): string {
  if (shell === "zsh") return path.join(homeDir, ".zshrc");
  if (shell === "fish") return path.join(homeDir, ".config", "fish", "config.fish");
  if (shell === "powershell") {
    return path.join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  }
  return path.join(homeDir, ".bashrc");
}

export function isShellIntegrationInstalled(shell: SupportedShell, rcContent: string, scriptPath: string): boolean {
  return rcContent.includes(scriptPath) || rcContent.includes(shellInstallSnippet(shell, scriptPath).trim());
}

export interface ShellInstallResult {
  shell: SupportedShell;
  scriptPath: string;
  rcFilePath: string;
  installed: boolean;
}

export function installShellIntegration(
  workspaceRoot: string,
  shell: SupportedShell,
  rcFilePath = defaultRcFilePath(shell),
  launcher = resolveShellLauncher(workspaceRoot)
): ShellInstallResult {
  const scriptPath = ensureShellIntegrationScript(workspaceRoot, shell, launcher);
  const snippet = shellInstallSnippet(shell, scriptPath);

  fs.mkdirSync(path.dirname(rcFilePath), { recursive: true });
  const current = fs.existsSync(rcFilePath) ? fs.readFileSync(rcFilePath, "utf8") : "";
  if (!isShellIntegrationInstalled(shell, current, scriptPath)) {
    const separator = current.endsWith("\n") || current.length === 0 ? "" : "\n";
    fs.writeFileSync(rcFilePath, `${current}${separator}${snippet}`);
  }

  return {
    shell,
    scriptPath,
    rcFilePath,
    installed: true
  };
}
