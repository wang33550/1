import type { CheckpointState, EventRecord, ResumePacket } from "./types";
import { clone, normalizeWhitespace, safeText, stableStringify } from "./utils";

const FALLBACK_NEXT_ACTION = "Await the next user instruction.";
const FRONTIER_EVENT_LIMIT = 6;

function isPlanLikeItem(value: unknown): value is { status?: unknown; text?: unknown; step?: unknown } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSemanticFrontierEvent(event: EventRecord): boolean {
  return !["checkpoint_created", "resume_started", "resume_finished"].includes(event.kind);
}

function normalizeText(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

interface FrontierPlanHints {
  nextAction?: string;
  planLines: string[];
}

function extractFrontierPlanHints(frontier: EventRecord[]): FrontierPlanHints {
  const latestPlan = [...frontier].reverse().find((event) => event.kind === "plan_update");
  if (!latestPlan) return { planLines: [] };

  const nextAction = normalizeWhitespace(safeText(latestPlan.payload.nextAction));
  const items = Array.isArray(latestPlan.payload.items)
    ? (latestPlan.payload.items as unknown[])
    : [];
  const planLines = items
    .filter(isPlanLikeItem)
    .map((item) => `- ${safeText(item.status || "pending")}: ${safeText(item.text || item.step)}`)
    .filter((line) => line.trim() !== "- :")
    .slice(0, 4);

  return {
    nextAction: nextAction || undefined,
    planLines
  };
}

function resolveCheckpointForResume(
  checkpoint: CheckpointState | undefined,
  frontier: EventRecord[]
): CheckpointState | undefined {
  if (!checkpoint) return undefined;

  const effective = clone(checkpoint);
  const hints = extractFrontierPlanHints(frontier);
  if (!hints.nextAction) {
    return effective;
  }

  const currentNextAction = normalizeText(effective.nextAction);
  const hintedNextAction = normalizeText(hints.nextAction);
  const planStillMatches = effective.currentPlan.some((item) => {
    const itemText = normalizeText(item.text);
    return itemText === currentNextAction && item.status !== "done";
  });

  if (
    !currentNextAction ||
    currentNextAction === normalizeText(FALLBACK_NEXT_ACTION) ||
    (!planStillMatches && currentNextAction !== hintedNextAction)
  ) {
    effective.nextAction = hints.nextAction;
  }

  return effective;
}

function summarizeEvent(event: EventRecord): string {
  const payload = event.payload;
  if (event.kind === "user_message" || event.kind === "assistant_message") {
    return safeText(payload.text || payload.content);
  }
  if (event.kind === "command_exec") {
    const command = safeText(payload.command);
    const summary = safeText(payload.summary);
    const exitCode = safeText(payload.exitCode);
    return summary
      ? `command=${command} exitCode=${exitCode} summary=${summary}`
      : `command=${command} exitCode=${exitCode}`;
  }
  if (event.kind === "file_write" || event.kind === "file_read") {
    const summary = safeText(payload.summary);
    return summary ? `path=${safeText(payload.path)} summary=${summary}` : `path=${safeText(payload.path)}`;
  }
  if (event.kind === "tool_call" || event.kind === "tool_result") {
    return `tool=${safeText(payload.toolName)} summary=${safeText(payload.summary || payload.outputSummary)}`;
  }
  if (event.kind === "plan_update") {
    const items = Array.isArray(payload.items) ? (payload.items as unknown[]) : [];
    const summarizedItems = items
      .filter(isPlanLikeItem)
      .map((item) => `${safeText(item.status || "pending")}:${safeText(item.text || item.step)}`)
      .filter(Boolean)
      .slice(0, 4)
      .join("; ");
    const nextAction = normalizeWhitespace(safeText(payload.nextAction));
    if (nextAction && summarizedItems) {
      return `nextAction=${nextAction} | ${summarizedItems}`;
    }
    if (nextAction) return `nextAction=${nextAction}`;
    if (summarizedItems) return summarizedItems;
    return stableStringify(payload);
  }
  return stableStringify(payload);
}

function renderFrontier(frontier: EventRecord[]): string {
  const semanticFrontier = frontier.filter(isSemanticFrontierEvent).slice(-FRONTIER_EVENT_LIMIT);
  if (semanticFrontier.length === 0) return "(empty)";
  return semanticFrontier
    .map((event) => `[${event.seq}] ${event.kind}: ${summarizeEvent(event)}`)
    .join("\n");
}

function renderPinnedMemory(checkpoint?: CheckpointState): string {
  if (!checkpoint || checkpoint.pinnedMemory.length === 0) return "(none)";
  return checkpoint.pinnedMemory.map((item) => `- ${item.text}`).join("\n");
}

function renderList(items: string[], empty = "(none)", limit = 6): string {
  if (items.length === 0) return empty;
  const visible = items.slice(0, limit).map((item) => `- ${item}`);
  if (items.length > limit) {
    visible.push(`- ... (${items.length - limit} more)`);
  }
  return visible.join("\n");
}

function renderCheckpointSummary(checkpoint?: CheckpointState): string {
  if (!checkpoint) return "(none)";

  const lines: string[] = [
    `goal: ${checkpoint.goal || "(unknown)"}`,
    `phase: ${checkpoint.phase}`,
    `next_action: ${checkpoint.nextAction}`
  ];

  if (checkpoint.successCriteria.length > 0) {
    lines.push(`success_criteria:`);
    lines.push(renderList(checkpoint.successCriteria));
  }
  if (checkpoint.constraints.length > 0) {
    lines.push(`constraints:`);
    lines.push(renderList(checkpoint.constraints.map((item) => item.text), "(none)", 4));
  }
  if (checkpoint.currentPlan.length > 0) {
    lines.push(`current_plan:`);
    lines.push(
      renderList(checkpoint.currentPlan.map((item) => `[${item.status}] ${item.text}`), "(none)", 4)
    );
  }
  if (checkpoint.done.length > 0) {
    lines.push(`done:`);
    lines.push(renderList(checkpoint.done.map((item) => item.text), "(none)", 4));
  }
  if (checkpoint.openItems.length > 0) {
    lines.push(`open_items:`);
    lines.push(renderList(checkpoint.openItems.map((item) => item.text), "(none)", 4));
  }
  if (checkpoint.verifiedFacts.length > 0) {
    lines.push(`verified_facts:`);
    lines.push(renderList(checkpoint.verifiedFacts.map((item) => item.text), "(none)", 3));
  }
  if (checkpoint.artifacts.length > 0) {
    lines.push(`artifacts:`);
    lines.push(
      renderList(
        checkpoint.artifacts.map((artifact) => artifact.summary || artifact.title),
        "(none)",
        5
      )
    );
  }
  if (checkpoint.doNotRepeat.length > 0) {
    lines.push(`do_not_repeat:`);
    lines.push(renderList(checkpoint.doNotRepeat, "(none)", 4));
  }
  if (checkpoint.blockers.length > 0) {
    lines.push(`blockers:`);
    lines.push(renderList(checkpoint.blockers, "(none)", 4));
  }
  if (checkpoint.unresolvedQuestions.length > 0) {
    lines.push(`unresolved_questions:`);
    lines.push(renderList(checkpoint.unresolvedQuestions, "(none)", 4));
  }

  return lines.join("\n");
}

function renderFrontierHints(
  frontier: EventRecord[],
  checkpoint?: CheckpointState
): string {
  const hints = extractFrontierPlanHints(frontier);
  if (!hints.nextAction && hints.planLines.length === 0) return "(none)";

  const shouldRepeatNextAction =
    hints.nextAction &&
    normalizeText(hints.nextAction) !== normalizeText(checkpoint?.nextAction || "");

  return [shouldRepeatNextAction ? `nextAction: ${hints.nextAction}` : null, ...hints.planLines]
    .filter(Boolean)
    .join("\n");
}

export class ResumeBuilder {
  build(checkpoint: CheckpointState | undefined, frontier: EventRecord[]): ResumePacket {
    const effectiveCheckpoint = resolveCheckpointForResume(checkpoint, frontier);
    const packet = [
      `<RUNTIME>`,
      `Resumed coding session.`,
      `Treat completed work as done.`,
      `Continue from next_action.`,
      `Avoid repeating protected actions unless stale or explicitly requested.`,
      `</RUNTIME>`,
      ``,
      `<CHECKPOINT>`,
      renderCheckpointSummary(effectiveCheckpoint),
      `</CHECKPOINT>`,
      ``,
      `<PINNED_MEMORY>`,
      renderPinnedMemory(effectiveCheckpoint),
      `</PINNED_MEMORY>`,
      ``,
      `<FRONTIER_HINTS>`,
      renderFrontierHints(frontier, effectiveCheckpoint),
      `</FRONTIER_HINTS>`,
      ``,
      `<RECENT_FRONTIER>`,
      renderFrontier(frontier),
      `</RECENT_FRONTIER>`
    ].join("\n");

    return {
      packet,
      checkpoint: effectiveCheckpoint,
      frontier
    };
  }
}
