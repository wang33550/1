# Trace Import

Task Recovery Runtime can now ingest normalized external traces from a host agent loop and replay them through the same evaluator used by the built-in benchmark.

## Format

The normalized trace schema is `trr_trace_v1`.

Required top-level fields:

- `version`
- `session`
- `events`

Optional fields:

- `description`
- `source`
- `minTailEvents`
- `checkpoint`
- `expected`

Example:

```json
{
  "version": "trr_trace_v1",
  "description": "Imported auth recovery trace",
  "session": {
    "provider": "custom",
    "model": "example-model",
    "workspaceRoot": "/workspace/demo"
  },
  "checkpoint": {
    "create": true,
    "force": true
  },
  "events": [
    {
      "kind": "user_message",
      "payload": {
        "text": "Fix the flaky auth test without changing the database schema."
      }
    }
  ]
}
```

## Event Mapping

Hosts should normalize their activity into these event kinds:

- `user_message`
- `assistant_message`
- `plan_update`
- `decision`
- `tool_call`
- `tool_result`
- `file_read`
- `file_write`
- `command_exec`
- `error`

Best-effort guidance:

- record explicit constraints as `decision` with `category: "constraint"`
- mark sticky memory with `pinned: true`
- emit `plan_update.nextAction` whenever the host knows the intended next step
- include `summary` on `file_write`, `tool_result`, and `command_exec` events when available
- mark side effects on commands or tool calls with `sideEffect: true`

## Import

```bash
trr trace import --file examples/trace-import.json
```

The importer creates a runtime session, appends every normalized event, and can create a checkpoint immediately if either:

- the trace file sets `checkpoint.create: true`
- the CLI call passes `--create-checkpoint`

## Replay

If the trace also contains an `expected` block, it can be replayed through the evaluator:

```bash
trr trace replay --file examples/trace-import.json --format markdown
```

The `expected` block supports:

- `nextAction`
- `requiredConstraints`
- `requiredArtifacts`
- `candidateActions`
- `sideEffectActions`

## Local Sources

This repository can now normalize traces directly from common local agent homes:

- Codex: archived session JSONL files under `$CODEX_HOME/archived_sessions`
- Claude: `history.jsonl` plus `todos/` under the local `.claude` directory

Useful commands:

```bash
trr trace harvest-local --out-dir .tmp/harvested-traces
trr trace normalize-codex --file /path/to/rollout.jsonl --out .tmp/codex-trace.json
trr trace normalize-claude --session <session-id> --out .tmp/claude-trace.json
```

By default these commands redact local home paths and common secret patterns before writing normalized traces.

## Current Scope

This path gives the project a real host-facing import surface without requiring a hard dependency on any single vendor runtime. It now includes practical Codex and Claude local importers, but it still does not include official upstream exporters and it does not yet compare multiple models over a large shared real-trace corpus by default.
