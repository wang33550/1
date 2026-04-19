# Evaluation

## Purpose

The runtime is only useful if it measurably improves recovery after compaction. This project evaluates that first with a deterministic replay benchmark, and now also supports replaying normalized external traces through the same scoring pipeline.

## Benchmark Design

The current benchmark is `benchmarks/recovery-benchmark.json`.

Each scenario contains:

- an ordered event trace
- the expected next action
- critical constraints that must survive compaction
- critical artifacts that should still be visible after recovery
- candidate duplicate actions
- candidate side-effect actions that should be blocked if repeated

## Strategies

### `full_history`

Uses the raw event history as the recovery input. This is the visibility oracle and token-cost upper bound. It does not provide execution-level duplicate protection.

### `simple_summary`

Uses a naive baseline:

- objective
- a tiny summary of older work
- the recent raw tail

It intentionally does not preserve structured checkpoint state or repeat-guard protection.

### `runtime`

Uses Task Recovery Runtime:

- checkpoint summary
- frontier hints
- recent frontier
- repeat guard

## Metrics

### `nextActionCoverage`

Whether the expected next step is still visible after compaction.

### `constraintCoverage`

Whether required constraints survive into the recovery context.

### `artifactCoverage`

Whether critical outputs remain visible after recovery.

### `duplicateProtectionCoverage`

How many repeated candidate actions are actively warned or blocked by the runtime.

### `sideEffectBlockCoverage`

How many repeated side-effect actions are actively blocked.

### `averageInputTokens`

Estimated prompt size of the recovery context.

### `tokenSavingsVsFullHistory`

Relative reduction compared with the raw history baseline.

## Running The Benchmark

```bash
npm run benchmark
```

Or:

```bash
npx tsx src/cli.ts eval run --dataset benchmarks/recovery-benchmark.json --format markdown
```

Replay an imported external trace:

```bash
npx tsx src/cli.ts trace replay --file examples/trace-import.json --format markdown
```

Run a live model replay over the same imported trace:

```bash
npx tsx src/cli.ts trace live-replay \
  --file examples/trace-import.json \
  --provider openai \
  --model gpt-5.3-codex \
  --format markdown
```

Run a harvested real-trace corpus:

```bash
npx tsx src/cli.ts eval corpus \
  --dir .tmp/harvested-traces \
  --min-events 5 \
  --format markdown
```

Run a higher-fidelity Codex-only slice:

```bash
npx tsx src/cli.ts eval corpus \
  --dir .tmp/harvested-traces \
  --min-events 5 \
  --host codex \
  --format markdown
```

The corpus command reads every normalized trace JSON file in a directory, uses `manifest.json` when present for host and quality labels, skips weak or incomplete traces according to the active filters, and then replays the remaining scenarios through the same benchmark pipeline.

## Real Corpus Method

The current real-corpus workflow is:

1. harvest redacted local traces with `trr trace harvest-local`
2. keep default `requireExpected=true` and `requireNextAction=true`
3. add `--min-events 5` to suppress near-empty sessions
4. optionally slice by `--host codex` to focus on higher-fidelity imported traces

This keeps the first real benchmark honest:

- it only scores traces that actually carry a resumable next step
- it does not let 1-2 event sessions dominate results
- it reports missing probe categories as `n/a` rather than pretending the runtime achieved guard coverage it could not measure

The latest real-corpus numbers for this machine are written in [Real Trace Results](REAL_TRACE_RESULTS.md).

## Limits

- The built-in benchmark dataset is deterministic and synthetic.
- Imported trace replay still depends on the quality of the exported normalized events and expectations.
- The current evaluator measures recovery capability and runtime guard coverage, not end-to-end live model behavior.
- Live replay now measures model recovery output against imported traces, but it still uses heuristic string scoring.
- Harvested real traces can prove recovery continuity today, but many host histories still do not include enough duplicate-action probes to measure replay guards from passive logs alone.
- The next milestone is collecting more exported traces and comparing multiple models on the same tasks.
