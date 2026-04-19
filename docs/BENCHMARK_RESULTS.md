# Benchmark Results

Dataset: `Synthetic Recovery Benchmark v1`

Interpretation:

- `full_history` is the raw-history visibility oracle and token-cost upper bound.
- `simple_summary` is a naive compaction baseline.
- `runtime` is Task Recovery Runtime with checkpoint, frontier hints, artifacts, and repeat guard.

## Aggregate

| Strategy | Next Action | Constraint Coverage | Artifact Coverage | Duplicate Protection | Side-effect Blocks | Avg Tokens | Savings vs Full History |
| --- | --- | --- | --- | --- | --- | --- | --- |
| full_history | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 366.3 | 0.0% |
| simple_summary | 50.0% | 33.3% | 66.7% | 0.0% | 0.0% | 122.3 | 66.6% |
| runtime | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 283.3 | 22.7% |

## Takeaways

- Compared with `simple_summary`, the runtime recovered every required next action and constraint in this dataset.
- The runtime blocked or warned every duplicated candidate action and blocked every repeated side-effect action in the benchmark.
- The runtime reduced estimated prompt size versus raw full history by `22.7%` while keeping full recovery and execution protection coverage.
- The real target use case is much longer coding sessions, where raw history grows linearly while checkpoint overhead grows much more slowly.

## What This Means

The current benchmark shows the runtime is already useful as a recovery layer:

- it preserves task state better than naive summarization
- it adds execution-level replay protection that raw history does not provide
- it now provides materially better prompt savings even on short synthetic traces
- it can replay normalized external traces through the same evaluation path

The next benchmark milestone is running live model-in-the-loop replays on imported traces from external hosts.
