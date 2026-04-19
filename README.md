# Task Recovery Runtime

[![CI](https://github.com/wang33550/1/actions/workflows/ci.yml/badge.svg)](https://github.com/wang33550/1/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Task Recovery Runtime (`trr`) is a cross-model state layer for coding agents. It turns long conversations and tool activity into structured checkpoints so an agent can continue from the current task frontier instead of redoing work after context compaction.

Status: `0.1.x developer preview`

## Goals

- Preserve task state across context windows.
- Reduce duplicate file reads, command executions, and side-effectful actions.
- Generate provider-neutral resume packets for OpenAI, Anthropic, or custom agents.
- Keep the state human-auditable through local checkpoints and artifacts.

## MVP Features

- Local persistent event store backed by a JSON database file.
- Deterministic checkpoint compiler with structured task state.
- Frontier extraction that keeps the active execution span instead of "last N messages".
- Repeat guard with action fingerprints and stale checks.
- Compact resume packet builder for provider-neutral recovery prompts.
- OpenAI and Anthropic adapters for text turns.
- Normalized trace import and replay for external host sessions.
- Codex archived-session and Claude history/todo normalization for real-trace harvesting.
- Directory-level corpus evaluation over harvested normalized traces.
- Live model replay harness for imported traces.
- CLI for session creation, event recording, checkpointing, resume inspection, and guard evaluation.

## Project Layout

```text
src/
  adapters/             Provider adapters
  checkpoint-compiler.ts
  cli.ts
  db.ts
  frontier.ts
  repeat-guard.ts
  resume-builder.ts
  runtime.ts
  safe-point.ts
  traces.ts
  types.ts
docs/
tests/
examples/
```

## Installation

Current recommended path is GitHub source install:

```bash
git clone https://github.com/wang33550/1.git
cd 1
npm install
npm run build
```

Then confirm the CLI is available:

```bash
node dist/cli.js --help
```

If you want a local command alias without publishing to npm yet:

```bash
npm link
trr --help
```

## Quick Start

```bash
npm run test
```

Create a session:

```bash
npx trr session create --provider openai --model gpt-5.3-codex --workspace "$(pwd)"
```

Append a user event:

```bash
npx trr event add \
  --session <session-id> \
  --kind user_message \
  --text "Fix the flaky auth tests without touching schema migrations."
```

Create a checkpoint:

```bash
npx trr checkpoint create --session <session-id>
```

Inspect the recovery packet:

```bash
npx trr resume build --session <session-id>
```

Import a normalized external trace:

```bash
npx trr trace import --file examples/trace-import.json
```

Replay that trace through the benchmark harness:

```bash
npx trr trace replay --file examples/trace-import.json --format markdown
```

Replay a harvested trace corpus with filtering:

```bash
npx trr eval corpus --dir .tmp/harvested-traces --min-events 5 --format markdown
```

Harvest real local traces from Codex and Claude homes:

```bash
npx trr trace harvest-local --out-dir .tmp/harvested-traces
```

Run a live model replay against the same imported trace:

```bash
npx trr trace live-replay \
  --file examples/trace-import.json \
  --provider openai \
  --model gpt-5.3-codex \
  --format markdown
```

## Typical User Flows

Evaluate the included example trace:

```bash
npx tsx src/cli.ts trace replay --file examples/trace-import.json --format markdown
```

Harvest local Codex and Claude traces, then evaluate them as a corpus:

```bash
npx tsx src/cli.ts trace harvest-local --out-dir .tmp/harvested-traces
npx tsx src/cli.ts eval corpus --dir .tmp/harvested-traces --min-events 5 --format markdown
```

Integrate the runtime into your own host loop:

- create a session
- record tool and message events
- create checkpoints at safe points
- build a resume packet after compaction
- use `guard check` or the runtime API before replaying a side-effectful action

## Architecture

The runtime stores raw events, compiles archived events into checkpoints at safe points, and only forwards:

- pinned memory
- the latest checkpoint
- the current frontier
- the current user input

This keeps recovery state compact without relying on opaque vendor summaries.

Further design details live in:

- [Architecture](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Evaluation](docs/EVALUATION.md)
- [Benchmark Results](docs/BENCHMARK_RESULTS.md)
- [Real Trace Results](docs/REAL_TRACE_RESULTS.md)
- [Checkpoint Schema](docs/CHECKPOINT_SCHEMA.md)
- [Provider Integration](docs/PROVIDER_INTEGRATION.md)
- [Trace Import](docs/TRACE_IMPORT.md)
- [CLI Usage](docs/CLI.md)
- [Contributing](CONTRIBUTING.md)
- [Trace Contributing](TRACE_CONTRIBUTING.md)

## Initial Results

Using the synthetic benchmark in [`benchmarks/recovery-benchmark.json`](benchmarks/recovery-benchmark.json):

- `runtime` preserved `100%` of expected next actions, constraints, and artifacts.
- `runtime` protected `100%` of duplicated candidate actions and blocked `100%` of repeated side effects.
- `runtime` reduced estimated prompt size by `22.7%` versus raw full history on the current short-trace dataset.
- imported normalized traces can now be replayed through the same evaluation pipeline with `trr trace replay`.
- imported traces can also be exercised against a live OpenAI or Anthropic model with `trr trace live-replay`.
- local Codex and Claude histories can now be harvested into redacted normalized traces with `trr trace harvest-local`.

The built-in benchmark is still deterministic and synthetic, but the runtime now includes a normalized trace path for external host exports. The next milestone is live model-in-the-loop replay on imported traces.

Using harvested real local traces on this machine:

- the local harvester found `13` usable trace files, with `7` carrying an explicit `expected.nextAction`
- a curated real corpus run on `6` traces (`--min-events 5`) kept `100%` next-action recovery for `runtime` versus `66.7%` for `simple_summary`
- that same curated run cut estimated prompt size by `99.4%` versus raw full history because one recovered Codex trace was extremely large
- on the higher-fidelity Codex-only subset (`3` traces), `runtime` kept `100%` next-action recovery while `simple_summary` dropped to `33.3%`
- current real-trace imports still lack enough duplicate-action probes to score guard behavior from harvested history alone, so those metrics remain `n/a` on the real corpus report

See [Real Trace Results](docs/REAL_TRACE_RESULTS.md) for the exact commands, corpus filters, and scenario-level output.

## Status

`0.1.0` is an MVP intended to prove the runtime contract:

- structure task state
- resume from next action
- guard against repeated execution

It does not yet include a UI, distributed storage, or built-in long-term semantic retrieval.
