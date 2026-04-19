# Roadmap

## 0.1.x

- Stable checkpoint schema
- Deterministic checkpoint compiler
- Provider-neutral resume packets
- Repeat guard for file reads, writes, commands, and side effects
- OpenAI and Anthropic text adapters

## 0.2.x

- SQLite and PostgreSQL store adapters
- Action invalidation policies per tool type
- Richer plan extraction from assistant output
- Exporters for Codex and Claude host traces
- Multi-trace live replay comparison across providers

## 0.3.x

- Tool-aware adapters for Aider, OpenHands, or internal coding agents
- Compaction quality evaluation suite
- Sidecar mode for wrapping existing agent loops

## 1.0

- Production-ready checkpoint compiler
- Robust stale detection
- Resume quality benchmarks
- Full adapter contracts for multi-provider coding agents
