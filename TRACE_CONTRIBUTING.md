# Trace Contributing

This project becomes more useful as the real trace corpus grows, but raw agent history can contain sensitive data. If you want to contribute traces, do it through redacted normalized exports rather than raw history dumps.

## What To Share

Preferred contribution format:

- normalized `trr_trace_v1` JSON files
- the corresponding `manifest.json` entry if you harvested a batch
- a short note explaining the task and why recovery quality matters

Preferred trace quality:

- at least `5` events
- includes `expected.nextAction`
- includes meaningful tool or plan events when available

## What Not To Share

Do not submit traces that expose:

- API keys
- bearer tokens
- passwords
- private repository URLs that must remain private
- customer data
- proprietary source code you do not have permission to publish

## Redaction Guidance

The built-in local harvester already redacts common home paths and common secret patterns by default.

Recommended flow:

```bash
npx tsx src/cli.ts trace harvest-local --out-dir .tmp/harvested-traces
```

Then inspect the generated files before sharing them.

If you need to normalize a single session manually:

```bash
npx tsx src/cli.ts trace normalize-codex --file /path/to/session.jsonl --out .tmp/codex-trace.json
npx tsx src/cli.ts trace normalize-claude --session <session-id> --out .tmp/claude-trace.json
```

## Contribution Checklist

- confirm the trace is redacted
- confirm the trace still contains enough structure to evaluate recovery
- include why this trace is useful
- mention whether it came from Codex, Claude, or another host
- mention whether the task involved file edits, command execution, or side effects

## Why This Matters

The current project already shows value on locally harvested traces, but stronger open benchmarking needs:

- more users
- more task types
- more long-running sessions
- more traces with explicit next-step expectations

Broader trace contributions are the fastest path to proving this project works across models and hosts.
