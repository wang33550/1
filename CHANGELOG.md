# Changelog

## 0.1.1

- Added compact resume packet rendering with better frontier hinting and less duplicated checkpoint content
- Improved benchmark token savings from `6.6%` to `22.7%` while keeping full recovery and guard coverage
- Added normalized trace import and replay APIs, CLI commands, tests, and example trace file
- Added live replay APIs and CLI flow for measuring imported traces against OpenAI or Anthropic models
- Added Codex archived-session normalization, Claude history/todo normalization, and local trace harvesting with redaction
- Added runtime coverage for stale checkpoint `next_action` fallback through frontier promotion
- Added corpus-level evaluation for directories of harvested normalized traces
- Added real local trace report showing `runtime` keeps `100%` next-action recovery on the curated harvested corpus while naive summary drops to `66.7%` overall and `33.3%` on the Codex-only slice

## 0.1.0

- Initial MVP release
- Added event store, checkpoint compiler, repeat guard, resume builder, and provider adapters
- Added CLI, tests, example, and architecture docs
