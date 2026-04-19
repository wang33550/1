import { CheckpointStateSchema } from "./schemas";
import type {
  ArtifactRef,
  CheckpointCompileInput,
  CheckpointState,
  EventRecord,
  MemoryItem,
  PlanItem,
  WorkItem
} from "./types";
import { clone, generateId, normalizeWhitespace, nowIso, safeText, sha256, uniqueStrings } from "./utils";

function createMemoryItem(text: string, eventId: string, pinned = false): MemoryItem {
  return {
    id: generateId("mem"),
    text: normalizeWhitespace(text),
    sourceEventIds: [eventId],
    pinned
  };
}

function createWorkItem(text: string, eventId: string): WorkItem {
  return {
    id: generateId("work"),
    text: normalizeWhitespace(text),
    evidenceEventIds: [eventId]
  };
}

function createEmptyCheckpoint(sessionId: string): CheckpointState {
  return {
    checkpointId: generateId("chk"),
    sessionId,
    createdAt: nowIso(),
    eventRange: { fromSeq: 1, toSeq: 0 },
    goal: "",
    successCriteria: [],
    phase: "scoping",
    constraints: [],
    pinnedMemory: [],
    decisions: [],
    verifiedFacts: [],
    done: [],
    openItems: [],
    blockers: [],
    currentPlan: [],
    nextAction: "Await the next user instruction.",
    artifacts: [],
    doNotRepeat: [],
    unresolvedQuestions: [],
    frontierAnchorSeq: 1
  };
}

function coercePlanItems(event: EventRecord): PlanItem[] {
  const rawItems = event.payload.items;
  if (!Array.isArray(rawItems)) return [];

  return rawItems
    .map((item, index) => {
      if (!item || typeof item !== "object") return undefined;
      const row = item as Record<string, unknown>;
      const text = safeText(row.text ?? row.step);
      const statusValue = safeText(row.status || "pending");
      if (!text) return undefined;
      const status: PlanItem["status"] =
        statusValue === "done" || statusValue === "in_progress" || statusValue === "blocked"
          ? statusValue
          : "pending";
      return {
        id: safeText(row.id) || `${event.id}_${index}`,
        text: normalizeWhitespace(text),
        status
      };
    })
    .filter((item): item is PlanItem => Boolean(item));
}

function isTestCommand(command: string): boolean {
  return /\b(test|pytest|vitest|jest|cargo test|go test|pnpm test|npm test)\b/i.test(command);
}

function mergeMemoryItems(current: MemoryItem[], incoming: MemoryItem[]): MemoryItem[] {
  const byText = new Map<string, MemoryItem>();
  for (const item of current) {
    byText.set(normalizeWhitespace(item.text).toLowerCase(), clone(item));
  }
  for (const item of incoming) {
    const key = normalizeWhitespace(item.text).toLowerCase();
    const existing = byText.get(key);
    if (!existing) {
      byText.set(key, clone(item));
      continue;
    }
    existing.sourceEventIds = uniqueStrings([...existing.sourceEventIds, ...item.sourceEventIds]);
    existing.pinned = existing.pinned || item.pinned;
  }
  return [...byText.values()];
}

function mergeWorkItems(current: WorkItem[], incoming: WorkItem[]): WorkItem[] {
  const byText = new Map<string, WorkItem>();
  for (const item of current) {
    byText.set(normalizeWhitespace(item.text).toLowerCase(), clone(item));
  }
  for (const item of incoming) {
    const key = normalizeWhitespace(item.text).toLowerCase();
    const existing = byText.get(key);
    if (!existing) {
      byText.set(key, clone(item));
      continue;
    }
    existing.evidenceEventIds = uniqueStrings([...existing.evidenceEventIds, ...item.evidenceEventIds]);
  }
  return [...byText.values()];
}

function mergeArtifacts(current: ArtifactRef[], incoming: ArtifactRef[]): ArtifactRef[] {
  const byKey = new Map<string, ArtifactRef>();
  for (const item of current) {
    byKey.set(item.id, clone(item));
  }
  for (const item of incoming) {
    if (!byKey.has(item.id)) {
      byKey.set(item.id, clone(item));
    }
  }
  return [...byKey.values()];
}

function planToWorkItems(items: PlanItem[]): { done: WorkItem[]; open: WorkItem[] } {
  const done = items
    .filter((item) => item.status === "done")
    .map((item) => ({ id: `done_${sha256(item.id).slice(0, 10)}`, text: item.text, evidenceEventIds: [] }));
  const open = items
    .filter((item) => item.status !== "done")
    .map((item) => ({ id: `open_${sha256(item.id).slice(0, 10)}`, text: item.text, evidenceEventIds: [] }));
  return { done, open };
}

export class DeterministicCheckpointCompiler {
  compile(input: CheckpointCompileInput): CheckpointState {
    const previous = input.previous ? clone(input.previous) : createEmptyCheckpoint(input.session.id);
    const state = clone(previous);

    state.checkpointId = generateId("chk");
    state.createdAt = nowIso();
    state.frontierAnchorSeq = input.frontierAnchorSeq;
    state.eventRange = {
      fromSeq: input.events[0]?.seq ?? previous.eventRange.toSeq + 1,
      toSeq: input.events[input.events.length - 1]?.seq ?? previous.eventRange.toSeq
    };

    const newConstraints: MemoryItem[] = [];
    const newPinned: MemoryItem[] = [];
    const newDecisions: MemoryItem[] = [];
    const newFacts: MemoryItem[] = [];
    const explicitDone: WorkItem[] = [];
    const explicitOpen: WorkItem[] = [];
    const blockers: string[] = [...state.blockers];
    const doNotRepeat = [...state.doNotRepeat];
    const unresolvedQuestions = [...state.unresolvedQuestions];

    const planMap = new Map<string, PlanItem>(state.currentPlan.map((item) => [item.id, clone(item)]));
    let goal = state.goal;
    let nextAction = state.nextAction;
    const successCriteria = [...state.successCriteria];

    for (const event of input.events) {
      if (event.kind === "user_message") {
        const text = normalizeWhitespace(
          safeText(event.payload.goal || event.payload.text || event.payload.content)
        );
        if (text && !goal) goal = text;
        if (event.payload.successCriteria && Array.isArray(event.payload.successCriteria)) {
          successCriteria.push(
            ...event.payload.successCriteria.map((value) => normalizeWhitespace(safeText(value)))
          );
        }
      }

      if (event.kind === "decision") {
        const text = normalizeWhitespace(safeText(event.payload.text || event.payload.summary));
        const category = normalizeWhitespace(safeText(event.payload.category || "decision")).toLowerCase();
        if (!text) continue;

        if (category.includes("constraint")) {
          newConstraints.push(createMemoryItem(text, event.id));
          if (event.payload.pinned === true) {
            newPinned.push(createMemoryItem(text, event.id, true));
          }
        } else if (category.includes("fact") || category.includes("verified")) {
          newFacts.push(createMemoryItem(text, event.id));
        } else {
          newDecisions.push(createMemoryItem(text, event.id));
        }
      }

      if (event.kind === "assistant_message") {
        const text = normalizeWhitespace(safeText(event.payload.text || event.payload.content));
        const extractedNextAction = normalizeWhitespace(safeText(event.payload.nextAction));
        if (extractedNextAction) {
          nextAction = extractedNextAction;
        }
        if (text && !goal && state.phase === "scoping") {
          goal = text;
        }
      }

      if (event.kind === "plan_update") {
        for (const item of coercePlanItems(event)) {
          planMap.set(item.id, item);
        }
        const explicitNextAction = normalizeWhitespace(safeText(event.payload.nextAction));
        if (explicitNextAction) {
          nextAction = explicitNextAction;
        }
      }

      if (event.kind === "file_write") {
        const path = normalizeWhitespace(safeText(event.payload.path));
        if (path) {
          explicitDone.push(createWorkItem(`Updated ${path}`, event.id));
        }
      }

      if (event.kind === "command_exec") {
        const command = normalizeWhitespace(safeText(event.payload.command));
        const exitCode = Number(event.payload.exitCode ?? NaN);
        if (command && isTestCommand(command)) {
          if (exitCode === 0) {
            newFacts.push(createMemoryItem(`Verified by command: ${command}`, event.id));
          } else {
            explicitOpen.push(createWorkItem(`Fix failing command: ${command}`, event.id));
            blockers.push(`Command failed: ${command}`);
          }
        } else if (command && Number.isFinite(exitCode) && exitCode !== 0) {
          blockers.push(`Command failed: ${command}`);
        }
      }

      if (event.kind === "tool_call" || event.kind === "command_exec") {
        const summary = normalizeWhitespace(
          safeText(event.payload.summary || event.payload.command || event.payload.toolName)
        );
        const sideEffect = event.payload.sideEffect === true;
        if (summary && sideEffect) {
          doNotRepeat.push(summary);
        }
      }

      if (event.kind === "error") {
        const message = normalizeWhitespace(safeText(event.payload.message || event.payload.text));
        if (message) {
          unresolvedQuestions.push(message);
        }
      }
    }

    state.goal = goal || previous.goal || "Continue the active task.";
    state.successCriteria = uniqueStrings(successCriteria);
    state.constraints = mergeMemoryItems(state.constraints, newConstraints);
    state.pinnedMemory = mergeMemoryItems(state.pinnedMemory, newPinned);
    state.decisions = mergeMemoryItems(state.decisions, newDecisions);
    state.verifiedFacts = mergeMemoryItems(state.verifiedFacts, newFacts);
    state.artifacts = mergeArtifacts(state.artifacts, input.artifacts);

    state.currentPlan = [...planMap.values()];
    const planDerived = planToWorkItems(state.currentPlan);
    state.done = mergeWorkItems(mergeWorkItems(state.done, explicitDone), planDerived.done);
    state.openItems = mergeWorkItems(mergeWorkItems(state.openItems, explicitOpen), planDerived.open);
    state.blockers = uniqueStrings(blockers);
    state.doNotRepeat = uniqueStrings(doNotRepeat);
    state.unresolvedQuestions = uniqueStrings(unresolvedQuestions);

    if (!nextAction || nextAction === previous.nextAction) {
      const preferredPlan =
        state.currentPlan.find((item) => item.status === "in_progress") ??
        state.currentPlan.find((item) => item.status === "pending");
      const preferredOpen = state.openItems[0];
      nextAction =
        preferredPlan?.text ??
        preferredOpen?.text ??
        (state.blockers.length > 0
          ? `Resolve blocker: ${state.blockers[0]}`
          : "Await the next user instruction.");
    }
    state.nextAction = nextAction;

    if (state.blockers.length > 0) {
      state.phase = "blocked";
    } else if (
      state.currentPlan.length > 0 &&
      state.openItems.length === 0 &&
      state.currentPlan.every((item) => item.status === "done")
    ) {
      state.phase = "done";
    } else if (
      state.currentPlan.some((item) => item.status === "in_progress") ||
      input.events.some((event) => event.kind === "file_write")
    ) {
      state.phase = "implementing";
    } else if (input.events.some((event) => event.kind === "command_exec")) {
      state.phase = "verifying";
    } else {
      state.phase = "scoping";
    }

    const parsed = CheckpointStateSchema.safeParse(state);
    if (!parsed.success) {
      throw new Error(`invalid checkpoint state: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
