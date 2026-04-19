# CLI Usage

All commands accept `--db <path>`. In the MVP this path points to the local persistent JSON store file.

## Session

Create a session:

```bash
trr session create --provider openai --model gpt-5.3-codex --workspace "$(pwd)"
```

List sessions:

```bash
trr session list
```

## Events

Append a simple text event:

```bash
trr event add --session <id> --kind user_message --text "Fix auth tests"
```

Append a structured event:

```bash
trr event add \
  --session <id> \
  --kind plan_update \
  --payload-json '{"items":[{"id":"inspect","text":"Inspect auth flow","status":"done"}]}'
```

List events:

```bash
trr event list --session <id>
```

## Checkpoints

Create a checkpoint:

```bash
trr checkpoint create --session <id>
```

Force a checkpoint:

```bash
trr checkpoint create --session <id> --force
```

Show the latest checkpoint:

```bash
trr checkpoint show --session <id>
```

## Resume Packet

```bash
trr resume build --session <id>
```

## Trace Import

Import a normalized external trace into the local store:

```bash
trr trace import --file examples/trace-import.json
```

Override the session id and force a checkpoint:

```bash
trr trace import \
  --file examples/trace-import.json \
  --session-id imported_auth_fix \
  --create-checkpoint \
  --force-checkpoint
```

If the trace file already contains a `checkpoint.create` flag, `trace import` respects it by default.

## Trace Normalization

Normalize a Codex archived session JSONL:

```bash
trr trace normalize-codex --file /path/to/rollout.jsonl --out .tmp/codex-trace.json
```

Normalize a Claude session from `history.jsonl` and `todos/`:

```bash
trr trace normalize-claude --session <session-id> --out .tmp/claude-trace.json
```

## Local Harvest

Harvest real local traces from default Codex and Claude homes:

```bash
trr trace harvest-local --out-dir .tmp/harvested-traces
```

This writes normalized trace JSON files plus a `manifest.json` with counts, source paths, and quality labels.

## Trace Replay

Replay a normalized trace through the benchmark harness:

```bash
trr trace replay --file examples/trace-import.json --format markdown
```

Write the replay report to disk:

```bash
trr trace replay --file examples/trace-import.json --format markdown --out docs/IMPORTED_TRACE_RESULTS.md
```

## Live Replay

Run a live model against each recovery strategy for an imported trace:

```bash
trr trace live-replay \
  --file examples/trace-import.json \
  --provider openai \
  --model gpt-5.3-codex \
  --format markdown
```

Replay only the runtime strategy:

```bash
trr trace live-replay \
  --file examples/trace-import.json \
  --provider anthropic \
  --model claude-sonnet-4-5 \
  --strategy runtime
```

Current practical note:

- `harvest-local` can collect whatever is already on the machine, but if you want `20-50` high-quality traces and local history is smaller than that, you still need more real sessions or opt-in testers.

## Guard

Evaluate whether an action should run again:

```bash
trr guard check \
  --session <id> \
  --action-json '{"actionType":"command_exec","command":"git push origin main","sideEffect":true}'
```

## Eval

Run the built-in recovery benchmark:

```bash
trr eval run --dataset benchmarks/recovery-benchmark.json --format markdown
```

Write the report to a file:

```bash
trr eval run --dataset benchmarks/recovery-benchmark.json --format markdown --out docs/BENCHMARK_RESULTS.md
```

Run a harvested trace corpus directly from a directory:

```bash
trr eval corpus --dir .tmp/harvested-traces --min-events 5 --format markdown
```

Filter to high-fidelity Codex traces only:

```bash
trr eval corpus --dir .tmp/harvested-traces --min-events 5 --host codex --format markdown
```

Available corpus filters:

- `--min-events <n>`
- `--min-user-messages <n>`
- `--host <csv>`
- `--quality <csv>`
- `--max-scenarios <n>`
- `--no-require-expected`
- `--no-require-next-action`

Current practical note:

- harvested real traces are often sparse or missing `expected.nextAction`, so the most useful first pass is usually `--min-events 5` with the default expectation filters left on
- corpus reports now render zero-probe coverage metrics as `n/a` instead of misleading `100%`

## Provider Turn

OpenAI or Anthropic text turn:

```bash
trr turn send --session <id> --user-input "Continue from the checkpoint and fix the remaining failures."
```

Required environment variables:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
