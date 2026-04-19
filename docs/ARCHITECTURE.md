# Architecture

## Problem

Most agent products already summarize or compact old context. The gap is not text compression itself, but task recovery after compaction. Agents often lose execution state and redo earlier work.

Task Recovery Runtime solves that by storing task progress outside the model's opaque context window.

## Core Loop

1. Capture every relevant interaction as an event.
2. Convert durable outputs into artifacts.
3. Fingerprint executable actions so repeats can be detected later.
4. At safe points, compile archived events into a structured checkpoint.
5. Keep only the latest checkpoint and the active frontier in the recovery packet.
6. On the next turn, rebuild the prompt from state instead of replaying the whole transcript.

## Components

### Event Store

Stores ordered events per session:

- user messages
- assistant messages
- tool calls
- tool results
- file reads
- file writes
- command executions
- decisions
- plan updates

### Artifact Index

Normalizes outputs that are useful to reference later:

- file updates
- command summaries
- test results
- tool outputs
- plan snapshots

### Checkpoint Compiler

Transforms archived events into `CheckpointState`.

The current compiler is deterministic. It merges:

- goal
- constraints
- pinned memory
- decisions
- verified facts
- plan state
- done items
- open items
- blockers
- next action
- do-not-repeat hints

### Frontier Extractor

Keeps the active execution band, not merely the newest messages. The extractor favors:

- the latest user turn
- the latest plan update
- unresolved tool output
- a minimum recent tail

### Repeat Guard

Builds fingerprints for reads, writes, commands, network calls, and tool calls.

It can:

- allow fresh actions
- warn on repeatable but not stale actions
- block non-repeatable side effects

### Resume Builder

Produces a provider-neutral packet:

- runtime contract
- checkpoint JSON
- pinned memory
- recent frontier

## Storage Model

The MVP ships with a local JSON-backed persistent store because it has zero native build requirements. The logical model stays the same if you replace the store with SQLite, PostgreSQL, or a remote event bus later.

## Design Principles

- State is more important than transcript.
- Frontier is more important than recency alone.
- Recovery must be auditable.
- Repeated execution must be guarded in code, not only in prompts.
- Providers are adapters, not the source of truth.
