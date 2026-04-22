import fs from "node:fs";
import path from "node:path";

import { normalizeWhitespace } from "./utils";

export interface HostProfileConfig {
  command: string;
  args: string[];
  model?: string;
  detection: HostDetectionConfig;
}

export interface HostDetectionConfig {
  sessionStartPatterns: string[];
  compactionPatterns: string[];
  resumeNeedPatterns: string[];
}

export interface GuardPolicyConfig {
  hardBlockCommandPrefixes: string[];
  softWarnCommandPrefixes: string[];
  readCommandPrefixes: string[];
}

export interface ResumePolicyConfig {
  resumeLatestOnStart: boolean;
  injectOnCompaction: boolean;
  restartOnCrash: boolean;
  maxAutoRestarts: number;
}

export interface RedactionPolicyConfig {
  redactHomePaths: boolean;
  redactCommonSecrets: boolean;
}

export interface TrrConfig {
  defaultHost: "codex" | "claude" | "generic-pty";
  workspaceRoot: string;
  storePath: string;
  hostProfiles: Record<"codex" | "claude" | "generic-pty", HostProfileConfig>;
  guardPolicy: GuardPolicyConfig;
  resumePolicy: ResumePolicyConfig;
  redactionPolicy: RedactionPolicyConfig;
}

export const CONFIG_FILE_NAME = "trr.config.json";

function maybeGitRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolveWorkspaceRoot(start = process.cwd()): string {
  const override = normalizeWhitespace(process.env.TRR_WORKSPACE_ROOT_OVERRIDE || "");
  if (override) return override;
  return maybeGitRoot(start) || path.resolve(start);
}

export function configPathFor(workspaceRoot = resolveWorkspaceRoot()): string {
  return path.join(workspaceRoot, CONFIG_FILE_NAME);
}

export function defaultConfig(workspaceRoot = resolveWorkspaceRoot()): TrrConfig {
  return {
    defaultHost: "codex",
    workspaceRoot,
    storePath: ".trr/trr-store.json",
    hostProfiles: {
      codex: {
        command: "codex",
        args: [],
        model: "codex",
        detection: {
          sessionStartPatterns: [],
          compactionPatterns: [],
          resumeNeedPatterns: []
        }
      },
      claude: {
        command: "claude",
        args: [],
        model: "claude",
        detection: {
          sessionStartPatterns: [],
          compactionPatterns: [],
          resumeNeedPatterns: []
        }
      },
      "generic-pty": {
        command: "",
        args: [],
        model: "generic-pty",
        detection: {
          sessionStartPatterns: [],
          compactionPatterns: [],
          resumeNeedPatterns: []
        }
      }
    },
    guardPolicy: {
      hardBlockCommandPrefixes: [
        "git push",
        "git commit",
        "rm",
        "mv",
        "cp",
        "curl",
        "wget"
      ],
      softWarnCommandPrefixes: [
        "npm test",
        "pnpm test",
        "yarn test",
        "pytest",
        "vitest",
        "jest",
        "cargo test",
        "go test",
        "make",
        "cat",
        "sed",
        "nl"
      ],
      readCommandPrefixes: ["cat", "sed", "nl"]
    },
    resumePolicy: {
      resumeLatestOnStart: true,
      injectOnCompaction: true,
      restartOnCrash: true,
      maxAutoRestarts: 1
    },
    redactionPolicy: {
      redactHomePaths: true,
      redactCommonSecrets: true
    }
  };
}

function mergeConfig(base: TrrConfig, override: Partial<TrrConfig>): TrrConfig {
  const mergeHostProfile = (
    host: keyof TrrConfig["hostProfiles"]
  ): HostProfileConfig => ({
    ...base.hostProfiles[host],
    ...(override.hostProfiles?.[host] ?? {}),
    detection: {
      ...base.hostProfiles[host].detection,
      ...(override.hostProfiles?.[host]?.detection ?? {})
    }
  });

  return {
    ...base,
    ...override,
    hostProfiles: {
      codex: mergeHostProfile("codex"),
      claude: mergeHostProfile("claude"),
      "generic-pty": mergeHostProfile("generic-pty")
    },
    guardPolicy: {
      ...base.guardPolicy,
      ...(override.guardPolicy ?? {})
    },
    resumePolicy: {
      ...base.resumePolicy,
      ...(override.resumePolicy ?? {})
    },
    redactionPolicy: {
      ...base.redactionPolicy,
      ...(override.redactionPolicy ?? {})
    }
  };
}

export function loadConfig(workspaceRoot = resolveWorkspaceRoot()): TrrConfig {
  const configPath = configPathFor(workspaceRoot);
  const defaults = defaultConfig(workspaceRoot);
  if (!fs.existsSync(configPath)) return defaults;

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<TrrConfig>;
  const merged = mergeConfig(defaults, raw);
  return {
    ...merged,
    // The config file's directory is the stable workspace anchor across WSL and
    // Windows launches. Persisted workspaceRoot values can be in the "wrong"
    // path dialect for the current runtime.
    workspaceRoot
  };
}

export function writeDefaultConfig(workspaceRoot = resolveWorkspaceRoot()): string {
  const configPath = configPathFor(workspaceRoot);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig(workspaceRoot), null, 2));
  }
  return configPath;
}

export function resolveStorePath(config: TrrConfig): string {
  return path.isAbsolute(config.storePath)
    ? config.storePath
    : path.join(config.workspaceRoot, config.storePath);
}
