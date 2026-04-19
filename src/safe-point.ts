import type { EventRecord, SafePointState } from "./types";

export function detectSafePoint(events: EventRecord[]): SafePointState {
  const pending = new Set<string>();

  for (const event of events) {
    if (event.kind === "tool_call") {
      pending.add(event.spanId ?? event.id);
    }
    if (event.kind === "tool_result") {
      const key = event.parentSpanId ?? event.spanId;
      if (key) pending.delete(key);
    }
  }

  if (pending.size > 0) {
    return {
      isSafe: false,
      pendingToolSpanIds: [...pending],
      reason: "tool calls are still pending"
    };
  }

  return {
    isSafe: true,
    pendingToolSpanIds: []
  };
}
