# API

## `TaskRecoveryRuntime`

Main orchestration class.

### Constructor

```ts
const runtime = new TaskRecoveryRuntime({
  dbPath: ".tmp/trr-store.json",
  minTailEvents: 6
});
```

### `createSession(input)`

Creates a logical session.

```ts
const session = runtime.createSession({
  provider: "openai",
  model: "gpt-5.3-codex",
  workspaceRoot: process.cwd()
});
```

### `recordEvent(input)`

Appends an event and automatically:

- estimates tokens
- indexes artifacts where possible
- remembers executable action fingerprints where possible

Example:

```ts
runtime.recordEvent({
  sessionId: session.id,
  kind: "command_exec",
  payload: {
    command: "vitest tests/auth/token-refresh.test.ts",
    exitCode: 0,
    summary: "1 test passed"
  }
});
```

### `createCheckpoint(sessionId, force?)`

Compiles a structured checkpoint from compilable history.

### `buildResumePacket(sessionId, options?)`

Returns:

```ts
{
  packet: string;
  checkpoint?: CheckpointState;
  frontier: EventRecord[];
}
```

### `assessAction(sessionId, action)`

Checks whether an action should be repeated.

### `maybeCompact(sessionId, softTokenThreshold?)`

Creates a checkpoint when estimated history size crosses a threshold.

## `loadTraceFile(filePath)`

Loads and validates a normalized external trace file.

```ts
const trace = loadTraceFile("examples/trace-import.json");
```

## `importTrace(runtime, trace, options?)`

Imports a normalized trace into a runtime session and optionally creates a checkpoint.

```ts
const result = importTrace(runtime, trace, {
  createCheckpoint: true,
  forceCheckpoint: true
});
```

Returns:

```ts
{
  sessionId: string;
  importedEvents: number;
  checkpointCreated: boolean;
  checkpointId?: string;
}
```

## `normalizeCodexArchivedSession(filePath, options?)`

Converts a Codex archived session JSONL file into `trr_trace_v1`.

## `normalizeClaudeSession(historyPath, todosDir, sessionId, options?)`

Converts a Claude `history.jsonl` session plus optional todo state into `trr_trace_v1`.

## `harvestLocalTraces(options)`

Harvests normalized traces from default local Codex and Claude homes and writes a manifest.

## `traceToEvalDataset(trace)`

Converts a normalized trace with expectations into a single-scenario evaluation dataset.

```ts
const dataset = traceToEvalDataset(trace);
const report = runEval(dataset);
```

## `loadTraceCorpus(options)`

Loads a directory of normalized `trr_trace_v1` files, applies filters, and produces:

- an `EvalDataset`
- included trace metadata
- skipped trace reasons
- a corpus summary

```ts
const corpus = loadTraceCorpus({
  dir: ".tmp/harvested-traces",
  minEvents: 5,
  requireNextAction: true
});

const report = runEval(corpus.dataset);
```

This is the main API for replaying harvested real traces as a batch instead of one imported file at a time.

## `runLiveReplay(dataset, options)`

Runs imported trace recovery against a live model using one or more strategies.

```ts
const report = await runLiveReplay(dataset, {
  provider: "openai",
  model: "gpt-5.3-codex",
  strategies: ["runtime"]
});
```

This is the bridge from deterministic replay to live model measurement.

## `OpenAIAdapter`

```ts
const adapter = new OpenAIAdapter(process.env.OPENAI_API_KEY);
const result = await adapter.sendTurn({
  model: "gpt-5.3-codex",
  runtimePacket,
  userInput: "Continue from the checkpoint.",
  systemPrompt: "You are a coding agent."
});
```

## `AnthropicAdapter`

```ts
const adapter = new AnthropicAdapter(process.env.ANTHROPIC_API_KEY);
const result = await adapter.sendTurn({
  model: "claude-sonnet-4-5",
  runtimePacket,
  userInput: "Continue from the checkpoint."
});
```

## Expected Host Integration

The SDK is most useful when the host emits structured events such as:

- `plan_update`
- `decision`
- `tool_call`
- `tool_result`
- `file_read`
- `file_write`
- `command_exec`

The better the event quality, the better the checkpoints and duplicate-action prevention.
