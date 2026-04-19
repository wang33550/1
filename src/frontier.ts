import type { EventRecord, FrontierResult } from "./types";

export interface FrontierOptions {
  minTailEvents?: number;
}

function findLastSeq(events: EventRecord[], kind: EventRecord["kind"]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.kind === kind) {
      return events[index]!.seq;
    }
  }
  return -1;
}

export function computeFrontier(
  events: EventRecord[],
  options: FrontierOptions = {}
): FrontierResult {
  if (events.length === 0) {
    return { anchorSeq: 1, archive: [], frontier: [] };
  }

  const minTailEvents = options.minTailEvents ?? 6;
  const lastSeq = events[events.length - 1]!.seq;
  const lastUserSeq = findLastSeq(events, "user_message");
  const lastPlanSeq = findLastSeq(events, "plan_update");
  const lastToolResultSeq = findLastSeq(events, "tool_result");
  const lastAssistantSeq = findLastSeq(events, "assistant_message");
  const unabsorbedToolSeq = lastToolResultSeq > lastAssistantSeq ? lastToolResultSeq : -1;

  const stickyAnchorCandidates = [lastUserSeq, lastPlanSeq, unabsorbedToolSeq].filter(
    (value) => value > 0
  );
  const stickyAnchor =
    stickyAnchorCandidates.length > 0
      ? Math.max(...stickyAnchorCandidates.map((candidate) => candidate))
      : -1;
  const tailAnchor = Math.max(1, lastSeq - minTailEvents + 1);
  const anchorSeq = stickyAnchor > 0 ? Math.min(stickyAnchor, tailAnchor) : tailAnchor;

  return {
    anchorSeq,
    archive: events.filter((event) => event.seq < anchorSeq),
    frontier: events.filter((event) => event.seq >= anchorSeq)
  };
}
