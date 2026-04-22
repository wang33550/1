import fs from "node:fs";
import path from "node:path";

import type { GuardPolicyConfig } from "./config";
import type { ProposedAction } from "./types";
import { normalizeWhitespace, safeText } from "./utils";

function projectRoot(): string {
  const parent = path.resolve(__dirname, "..");
  const base = path.basename(parent);
  if (base === "src" || base === "dist") return path.dirname(parent);
  return parent;
}

function shellEscape(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

function cmdEscape(value: string): string {
  return `"${value.replace(/"/g, "\"\"").replace(/%/g, "%%")}"`;
}

export function resolveExecInvocation(): { executable: string; args: string[] } {
  const root = projectRoot();
  const distEntry = path.join(root, "dist", "bin", "trr-exec.js");
  if (fs.existsSync(distEntry)) {
    return {
      executable: process.execPath,
      args: [distEntry]
    };
  }

  const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
  const sourceEntry = path.join(root, "src", "bin", "trr-exec.ts");
  if (fs.existsSync(tsxBin) && fs.existsSync(sourceEntry)) {
    return {
      executable: tsxBin,
      args: [sourceEntry]
    };
  }

  throw new Error("unable to resolve trr-exec entrypoint");
}

export function shouldTreatAsSideEffect(commandLine: string, policy: GuardPolicyConfig): boolean {
  const normalized = normalizeWhitespace(commandLine);
  return policy.hardBlockCommandPrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function shouldWarnOnCommand(commandLine: string, policy: GuardPolicyConfig): boolean {
  const normalized = normalizeWhitespace(commandLine);
  return policy.softWarnCommandPrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function parseReadAction(commandName: string, args: string[]): ProposedAction | undefined {
  const normalizedCommand = normalizeWhitespace([commandName, ...args].join(" "));
  if (commandName === "cat" && args[0]) {
    return {
      actionType: "file_read",
      path: args[0],
      dependsOnPaths: [args[0]]
    };
  }
  const sedMatch = normalizedCommand.match(/sed\s+-n\s+'?(\d+),(\d+)p'?\s+(.+)$/);
  if (commandName === "sed" && sedMatch) {
    const filePath = sedMatch[3]?.replace(/^['"]|['"]$/g, "");
    if (!filePath) return undefined;
    return {
      actionType: "file_read",
      path: filePath,
      startLine: Number(sedMatch[1]),
      endLine: Number(sedMatch[2]),
      dependsOnPaths: [filePath]
    };
  }
  if (commandName === "nl" && args[args.length - 1]) {
    const filePath = args[args.length - 1];
    if (!filePath) return undefined;
    return {
      actionType: "file_read",
      path: filePath,
      dependsOnPaths: [filePath]
    };
  }
  return undefined;
}

export function shimCommandNames(policy: GuardPolicyConfig): string[] {
  const names = new Set<string>([
    "git",
    "rm",
    "mv",
    "cp",
    "curl",
    "wget",
    "npm",
    "pnpm",
    "yarn",
    "pytest",
    "vitest",
    "jest",
    "cargo",
    "go",
    "make",
    "cat",
    "sed",
    "nl"
  ]);
  for (const prefix of [...policy.hardBlockCommandPrefixes, ...policy.softWarnCommandPrefixes]) {
    const name = normalizeWhitespace(prefix).split(/\s+/)[0];
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function ensureShimDirectory(workspaceRoot: string, policy: GuardPolicyConfig): string {
  const dir = path.join(workspaceRoot, ".trr", "shims");
  fs.mkdirSync(dir, { recursive: true });

  for (const commandName of shimCommandNames(policy)) {
    const filePath = path.join(dir, commandName);
    fs.writeFileSync(
      filePath,
      [
        "#!/usr/bin/env bash",
        'if [[ -z "${TRR_NODE_EXECUTABLE:-}" || -z "${TRR_EXEC_ENTRY:-}" ]]; then',
        '  echo "trr shim requires TRR_NODE_EXECUTABLE and TRR_EXEC_ENTRY" >&2',
        "  exit 1",
        "fi",
        `exec "$TRR_NODE_EXECUTABLE" "$TRR_EXEC_ENTRY" ${shellEscape(commandName)} "$@"`,
        ""
      ].join("\n")
    );
    fs.chmodSync(filePath, 0o755);

    fs.writeFileSync(
      `${filePath}.cmd`,
      [
        "@echo off",
        'if "%TRR_NODE_EXECUTABLE%"=="" (',
        "  echo trr shim requires TRR_NODE_EXECUTABLE 1>&2",
        "  exit /b 1",
        ")",
        'if "%TRR_EXEC_ENTRY%"=="" (',
        "  echo trr shim requires TRR_EXEC_ENTRY 1>&2",
        "  exit /b 1",
        ")",
        `"%TRR_NODE_EXECUTABLE%" "%TRR_EXEC_ENTRY%" ${cmdEscape(commandName)} %*`,
        ""
      ].join("\r\n")
    );
  }
  return dir;
}

export function findRealExecutable(commandName: string, pathValue: string, excludeDir?: string): string | undefined {
  const entries = pathValue.split(path.delimiter).filter(Boolean);
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const baseHasExtension = path.extname(commandName) !== "";
  const candidateNames = baseHasExtension
    ? [commandName]
    : process.platform === "win32"
      ? [...pathext.map((extension) => `${commandName}${extension.toLowerCase()}`), commandName]
      : [commandName, ...pathext.map((extension) => `${commandName}${extension.toLowerCase()}`)];

  for (const entry of entries) {
    if (excludeDir && path.resolve(entry) === path.resolve(excludeDir)) {
      continue;
    }
    for (const candidateName of candidateNames) {
      const candidate = path.join(entry, candidateName);
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export function commandSummary(commandName: string, args: string[]): string {
  return normalizeWhitespace([commandName, ...args].map((value) => safeText(value)).join(" "));
}
