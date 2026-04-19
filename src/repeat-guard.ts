import fs from "node:fs";
import path from "node:path";

import type {
  ActionFingerprint,
  GuardDraft,
  GuardResult,
  ProposedAction,
  RepeatPolicy,
  SaveFingerprintInput
} from "./types";
import { RuntimeDatabase } from "./db";
import { sha256, stableStringify } from "./utils";

function normalizeCommand(command: string, cwd?: string): string {
  return stableStringify({
    cmd: command.trim().replace(/\s+/g, " "),
    cwd: cwd?.trim() || null
  });
}

function normalizeFileRead(action: ProposedAction): string {
  return stableStringify({
    path: action.path || null,
    startLine: action.startLine ?? null,
    endLine: action.endLine ?? null
  });
}

function normalizeFileWrite(action: ProposedAction): string {
  return stableStringify({
    path: action.path || null,
    afterHash: action.afterHash || null
  });
}

function normalizeNetwork(action: ProposedAction): string {
  return stableStringify({
    uri: action.uri || null,
    input: action.input || null
  });
}

function normalizeToolCall(action: ProposedAction): string {
  return stableStringify({
    toolName: action.toolName || null,
    input: action.input || null
  });
}

function inferRepeatPolicy(action: ProposedAction): RepeatPolicy {
  if (action.sideEffect) return "never";
  if (action.actionType === "network") return "only_if_stale";
  if (action.actionType === "tool_call") return action.sideEffect ? "never" : "only_if_stale";
  return "only_if_stale";
}

function buildDraft(action: ProposedAction): GuardDraft {
  let normalizedSignature = "";
  if (action.actionType === "command_exec") {
    normalizedSignature = normalizeCommand(action.command || "", action.cwd);
  } else if (action.actionType === "file_read") {
    normalizedSignature = normalizeFileRead(action);
  } else if (action.actionType === "file_write") {
    normalizedSignature = normalizeFileWrite(action);
  } else if (action.actionType === "network") {
    normalizedSignature = normalizeNetwork(action);
  } else {
    normalizedSignature = normalizeToolCall(action);
  }

  return {
    normalizedSignature,
    hash: sha256(normalizedSignature),
    actionType: action.actionType,
    repeatPolicy: inferRepeatPolicy(action),
    dependsOnPaths: action.dependsOnPaths ?? (action.path ? [action.path] : []),
    envDigest: action.envDigest
  };
}

function fileDigest(targetPath: string): string | undefined {
  try {
    const stats = fs.statSync(targetPath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return undefined;
  }
}

function isFingerprintStale(
  matched: ActionFingerprint,
  action: ProposedAction
): boolean {
  if (action.actionType === "file_read" || action.actionType === "file_write") {
    if (!action.path) return false;
    const current = fileDigest(path.resolve(action.path));
    const previous = matched.resourceDigests?.[action.path];
    return current !== previous;
  }

  if (action.actionType === "command_exec") {
    const digests = matched.resourceDigests ?? {};
    const depends = action.dependsOnPaths ?? [];
    for (const target of depends) {
      const current = fileDigest(path.resolve(target));
      if ((digests[target] ?? undefined) !== current) {
        return true;
      }
    }
    return false;
  }

  if (action.actionType === "network") {
    const ttlSeconds = action.ttlSeconds ?? 300;
    const ageMs = Date.now() - Date.parse(matched.executedAt);
    return ageMs > ttlSeconds * 1000;
  }

  return false;
}

export class RepeatGuard {
  constructor(private readonly db: RuntimeDatabase) {}

  assess(sessionId: string, action: ProposedAction): GuardResult {
    const draft = buildDraft(action);
    const matched = this.db.findLatestFingerprint(sessionId, draft.hash);
    if (!matched) {
      return { decision: "allow", stale: false, draft };
    }

    const stale = isFingerprintStale(matched, action);
    if (matched.repeatPolicy === "never" && !stale) {
      return {
        decision: "block",
        stale,
        draft,
        matched,
        reason: "matching non-repeatable action already exists"
      };
    }
    if (matched.repeatPolicy === "only_if_stale" && !stale) {
      return {
        decision: "warn",
        stale,
        draft,
        matched,
        reason: "matching action already exists and inputs are not stale"
      };
    }
    return {
      decision: "allow",
      stale,
      draft,
      matched
    };
  }

  remember(
    sessionId: string,
    sourceEventId: string,
    action: ProposedAction,
    artifactIds: string[] = []
  ): ActionFingerprint {
    const draft = buildDraft(action);
    const resourceDigests: Record<string, string> = {};
    for (const filePath of draft.dependsOnPaths) {
      const digest = fileDigest(path.resolve(filePath));
      if (digest) resourceDigests[filePath] = digest;
    }

    const input: SaveFingerprintInput = {
      sessionId,
      sourceEventId,
      actionType: draft.actionType,
      normalizedSignature: draft.normalizedSignature,
      hash: draft.hash,
      repeatPolicy: draft.repeatPolicy,
      artifactIds,
      dependsOnPaths: draft.dependsOnPaths,
      envDigest: draft.envDigest,
      resourceDigests
    };
    return this.db.saveFingerprint(input);
  }
}
