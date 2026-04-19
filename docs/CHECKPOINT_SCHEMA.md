# Checkpoint Schema

`CheckpointState` is the durable unit of recovery.

```ts
interface CheckpointState {
  checkpointId: string;
  sessionId: string;
  createdAt: string;
  eventRange: { fromSeq: number; toSeq: number };
  goal: string;
  successCriteria: string[];
  phase: "scoping" | "implementing" | "verifying" | "blocked" | "done";
  constraints: MemoryItem[];
  pinnedMemory: MemoryItem[];
  decisions: MemoryItem[];
  verifiedFacts: MemoryItem[];
  done: WorkItem[];
  openItems: WorkItem[];
  blockers: string[];
  currentPlan: PlanItem[];
  nextAction: string;
  artifacts: ArtifactRef[];
  doNotRepeat: string[];
  unresolvedQuestions: string[];
  frontierAnchorSeq: number;
}
```

## Field Semantics

### `goal`

The active objective. This should reflect what the user is asking for now, not historical background.

### `constraints`

Requirements that still constrain future behavior.

Examples:

- do not touch schema migrations
- preserve API compatibility
- stay inside the workspace

### `pinnedMemory`

Constraints or facts that should survive aggressive compaction even if they are old.

### `decisions`

Important choices that future steps depend on.

### `verifiedFacts`

Only facts with evidence from events or artifacts.

### `done`

Completed work that should not be redone by default.

### `openItems`

Work that still remains. This is different from `currentPlan`: it represents unresolved work, regardless of whether the agent currently has an explicit plan object.

### `currentPlan`

Structured execution plan with statuses.

### `nextAction`

The single best next step after resume.

### `doNotRepeat`

Actions that should not run again automatically. This is usually populated from side-effectful commands or tool calls.

### `frontierAnchorSeq`

The first event sequence number that remains in raw form after compaction.

## Compiler Rules

- Preserve prior state unless contradicted by new evidence.
- Promote to `verifiedFacts` only with evidence.
- Prefer moving completed plan items into `done`.
- Keep unresolved failures in `blockers` and `openItems`.
- Always set `nextAction`, unless the whole task is done.
