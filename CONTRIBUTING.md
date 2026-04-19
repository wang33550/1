# Contributing

## Scope

This project focuses on task recovery for long-running coding agents. Contributions should improve one of these areas:

- event capture
- checkpoint compilation
- repeat guarding
- resume quality
- provider integration
- evaluation

## Development

```bash
npm install
npm run build
npm run test
```

If your change touches imported or harvested traces, also read `TRACE_CONTRIBUTING.md`.

## Pull Request Guidelines

- Keep changes small and reviewable.
- Add or update tests for behavior changes.
- Update docs when contracts or CLI behavior changes.
- Do not merge provider-specific hacks into the core runtime unless they generalize.

## Suggested Contribution Areas

- new store adapters
- richer deterministic extraction
- eval datasets for recovery quality
- additional model adapters
- artifact indexing improvements

## Definition of Done

- code builds
- tests pass
- docs are updated
- recovery behavior is explained, not only implemented
