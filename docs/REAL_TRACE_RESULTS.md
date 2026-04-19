# Real Trace Results

This report captures the first corpus-level replay runs over real local traces harvested from this machine on `2026-04-19`.

The goal is not to claim universal benchmark truth. The goal is narrower and more practical:

- prove the runtime helps on real harvested sessions, not only synthetic examples
- show whether `runtime` preserves `nextAction` better than naive summarization
- measure whether the runtime packet stays materially smaller than raw full history

## Corpus Source

Harvest source:

- Codex archived sessions from `%USERPROFILE%\\.codex\\archived_sessions`
- Claude history and todos from `%USERPROFILE%\\.claude`

Harvest outputs:

- mixed corpus manifest: `.tmp/harvested-traces/manifest.json`
- mixed corpus markdown replay: `.tmp/reports/real-trace-corpus.md`
- Codex-only markdown replay: `.tmp/reports/real-trace-codex-only.md`

Observed local supply on this machine:

- `13` normalized trace files harvested
- `7` traces with `expected.nextAction`
- `6` traces kept in the curated mixed run after `--min-events 5`
- `3` Codex-only high-fidelity traces kept after `--min-events 5 --host codex`

## Commands

Curated mixed corpus:

```bash
npx tsx src/cli.ts eval corpus \
  --dir .tmp/harvested-traces \
  --min-events 5 \
  --format markdown \
  --out .tmp/reports/real-trace-corpus.md
```

Curated Codex-only slice:

```bash
npx tsx src/cli.ts eval corpus \
  --dir .tmp/harvested-traces \
  --min-events 5 \
  --host codex \
  --format markdown \
  --out .tmp/reports/real-trace-codex-only.md
```

## Main Result

Mixed curated corpus, `6` scenarios:

| Strategy | Next Action | Avg Tokens | Savings vs Full History |
| --- | --- | --- | --- |
| `full_history` | `100.0% (6/6)` | `65151.3` | `0.0%` |
| `simple_summary` | `66.7% (4/6)` | `355.5` | `99.5%` |
| `runtime` | `100.0% (6/6)` | `398.8` | `99.4%` |

What that means:

- the runtime matched raw full history on next-step continuity for all `6` real scenarios
- naive summary lost the active next step on `2` real Codex traces
- runtime used slightly more tokens than naive summary, but still stayed tiny relative to raw history
- the large savings number is driven by one very long Codex session (`codex_006`, `366201` estimated input tokens as raw history)

## High-Fidelity Codex Slice

Codex-only curated corpus, `3` scenarios:

| Strategy | Next Action | Avg Tokens | Savings vs Full History |
| --- | --- | --- | --- |
| `full_history` | `100.0% (3/3)` | `129832.3` | `0.0%` |
| `simple_summary` | `33.3% (1/3)` | `597.0` | `99.5%` |
| `runtime` | `100.0% (3/3)` | `633.7` | `99.5%` |

This is the stronger signal right now because Codex archived sessions preserve richer event fidelity than the current Claude importer.

## Scenario-Level Notes

Failures for `simple_summary` came from:

- `codex_002`: lost next step `改写报告叙述视角`
- `codex_006`: lost next step `前台重跑 strict full-test，确认 handoff / full loop 证据链仍然稳定`

In both cases, `runtime` preserved the next step.

## Limits

- These real traces were harvested from one machine, not multiple users.
- The current harvested corpus is still small.
- Claude imports currently provide weaker tool fidelity than Codex archived sessions.
- Harvested passive traces currently do not carry enough duplicate-action and side-effect probe data, so those guard metrics show `n/a` in the real corpus report.

## Bottom Line

The project has crossed the line from architecture-only to practically useful:

- it can harvest real local traces automatically
- it can batch-evaluate them without manual dataset authoring
- it already shows a concrete real-world recovery advantage over naive summarization on the available high-value traces

The next proof upgrade is breadth, not basic viability: collect more real traces from more users and add active guard probes to imported trace datasets.
