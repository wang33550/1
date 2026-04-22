import type { HostProfileConfig } from "./config";
import { normalizeWhitespace, safeText } from "./utils";

export interface HostPlanHint {
  items?: Array<{ id: string; text: string; status: "pending" | "in_progress" | "done" | "blocked" }>;
  nextAction?: string;
}

export interface HostToolHint {
  toolName?: string;
  command?: string;
  summary?: string;
  sideEffect?: boolean;
}

export interface HostAdapter {
  id: "codex" | "claude" | "generic-pty";
  detectSessionStart(outputChunk: string): boolean;
  detectCompaction(outputChunk: string): { matched: boolean; reason?: string };
  detectNeedResume(outputChunk: string): { matched: boolean; reason?: string };
  extractPlanHints(outputChunk: string): HostPlanHint | undefined;
  extractToolHints(outputChunk: string): HostToolHint | undefined;
  buildResumeEnvelope(packet: string): string;
}

const ANSI_PATTERN = /\u001b\][^\u0007]*\u0007|\u001b\[[0-?]*[ -/]*[@-~]/g;

function sanitizeOutputChunk(outputChunk: string): string {
  return outputChunk
    .replace(ANSI_PATTERN, "")
    .replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g, "");
}

function parseJsonSuffix(prefix: string, outputChunk: string): Record<string, unknown> | undefined {
  const line = sanitizeOutputChunk(outputChunk)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(prefix.length).trim()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseNextAction(outputChunk: string): HostPlanHint | undefined {
  const marker = sanitizeOutputChunk(outputChunk).match(/(?:NEXT_ACTION|next action)\s*[:=]\s*([^\n\r]+)/i)?.[1];
  const nextAction = normalizeWhitespace(marker || "");
  return nextAction ? { nextAction } : undefined;
}

function genericPlanHints(outputChunk: string): HostPlanHint | undefined {
  const parsed = parseJsonSuffix("TRR_PLAN", outputChunk);
  if (parsed) {
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((item, index) => {
            if (!item || typeof item !== "object") return undefined;
            const row = item as Record<string, unknown>;
            const text = normalizeWhitespace(safeText(row.text || row.step));
            if (!text) return undefined;
            const rawStatus = normalizeWhitespace(safeText(row.status || "pending"));
            const status =
              rawStatus === "done" || rawStatus === "in_progress" || rawStatus === "blocked"
                ? rawStatus
                : "pending";
            return {
              id: safeText(row.id) || `plan_${index}`,
              text,
              status
            };
          })
          .filter(
            (item): item is { id: string; text: string; status: "pending" | "in_progress" | "done" | "blocked" } =>
              Boolean(item)
          )
      : undefined;
    const nextAction = normalizeWhitespace(safeText(parsed.nextAction));
    if (items || nextAction) {
      return {
        items,
        nextAction: nextAction || undefined
      };
    }
  }
  return parseNextAction(outputChunk);
}

function genericToolHints(outputChunk: string): HostToolHint | undefined {
  const parsed = parseJsonSuffix("TRR_TOOL", outputChunk);
  if (!parsed) return undefined;
  return {
    toolName: normalizeWhitespace(safeText(parsed.toolName)),
    command: normalizeWhitespace(safeText(parsed.command)),
    summary: normalizeWhitespace(safeText(parsed.summary)),
    sideEffect: parsed.sideEffect === true
  };
}

function detectByPatterns(outputChunk: string, patterns: RegExp[]): { matched: boolean; reason?: string } {
  const normalized = sanitizeOutputChunk(outputChunk);
  const pattern = patterns.find((candidate) => candidate.test(normalized));
  return {
    matched: Boolean(pattern),
    reason: pattern?.source
  };
}

function resumeEnvelope(host: string, packet: string): string {
  return [
    `[TRR_RESUME_PACKET_BEGIN host=${host}]`,
    `Use this runtime recovery packet to continue the current task without redoing completed work.`,
    packet,
    `[TRR_RESUME_PACKET_END]`
  ].join("\n");
}

const genericSessionStartPatterns = [
  /ready>/i,
  /^\$/im,
  /^>/im,
  /session started/i,
  /welcome/i
];
const genericCompactionPatterns = [
  /compacting conversation/i,
  /context window full/i,
  /summarizing old context/i,
  /handoff/i
];
const genericResumeNeedPatterns = [
  /need (?:runtime )?recovery packet/i,
  /need resume/i,
  /lost context/i,
  /continue from checkpoint/i
];

function compileConfiguredPatterns(patterns: string[]): RegExp[] {
  return patterns
    .map((pattern) => normalizeWhitespace(pattern))
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern, "i"));
}

function mergePatternSets(builtIn: RegExp[], configured: string[]): RegExp[] {
  return [...builtIn, ...compileConfiguredPatterns(configured)];
}

function createAdapter(
  id: HostAdapter["id"],
  defaults: {
    sessionStartPatterns: RegExp[];
    compactionPatterns: RegExp[];
    resumeNeedPatterns: RegExp[];
  },
  profile?: HostProfileConfig
): HostAdapter {
  const configured = profile?.detection;
  const sessionStartPatterns = mergePatternSets(defaults.sessionStartPatterns, configured?.sessionStartPatterns ?? []);
  const compactionPatterns = mergePatternSets(defaults.compactionPatterns, configured?.compactionPatterns ?? []);
  const resumeNeedPatterns = mergePatternSets(defaults.resumeNeedPatterns, configured?.resumeNeedPatterns ?? []);

  return {
    id,
    detectSessionStart(outputChunk: string) {
      return sessionStartPatterns.some((pattern) => pattern.test(sanitizeOutputChunk(outputChunk)));
    },
    detectCompaction(outputChunk: string) {
      return detectByPatterns(outputChunk, compactionPatterns);
    },
    detectNeedResume(outputChunk: string) {
      return detectByPatterns(outputChunk, resumeNeedPatterns);
    },
    extractPlanHints: genericPlanHints,
    extractToolHints: genericToolHints,
    buildResumeEnvelope(packet: string) {
      return resumeEnvelope(id, packet);
    }
  };
}

export function adapterForHost(host: string, profile?: HostProfileConfig): HostAdapter {
  if (host === "codex") {
    return createAdapter(
      "codex",
      {
        sessionStartPatterns: [...genericSessionStartPatterns, /codex/i, /continue/i],
        compactionPatterns: [...genericCompactionPatterns, /condensing context/i, /compressing context/i],
        resumeNeedPatterns: [...genericResumeNeedPatterns, /restore state/i, /resume packet/i]
      },
      profile
    );
  }
  if (host === "claude") {
    return createAdapter(
      "claude",
      {
        sessionStartPatterns: [...genericSessionStartPatterns, /claude/i, /continue/i],
        compactionPatterns: [...genericCompactionPatterns, /context condensed/i, /compact summary/i],
        resumeNeedPatterns: [
          ...genericResumeNeedPatterns,
          /need current task state/i,
          /please remind me where we left off/i
        ]
      },
      profile
    );
  }
  return createAdapter(
    "generic-pty",
    {
      sessionStartPatterns: genericSessionStartPatterns,
      compactionPatterns: genericCompactionPatterns,
      resumeNeedPatterns: genericResumeNeedPatterns
    },
    profile
  );
}

export const GenericPtyHostAdapter = adapterForHost("generic-pty");
export const CodexHostAdapter = adapterForHost("codex");
export const ClaudeHostAdapter = adapterForHost("claude");
