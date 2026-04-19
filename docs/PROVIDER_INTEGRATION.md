# Provider Integration

Task Recovery Runtime is provider-neutral. The runtime owns task state; model adapters only send and receive turns.

## OpenAI

`OpenAIAdapter` uses the Responses API.

Flow:

1. Record the user message as an event.
2. Build a recovery packet with `excludeLatestUser: true`.
3. Send:
   - optional system prompt
   - runtime packet as system content
   - current user input as the user turn
4. Record the assistant text as an event.
5. Call `maybeCompact()`.

This design complements OpenAI server-side compaction instead of trying to replace it.

## Anthropic

`AnthropicAdapter` uses the Messages API.

Flow is the same, except the runtime packet is appended to the `system` field. If you later integrate Anthropic's native compaction hooks, inject the runtime packet again after compaction so task state is preserved.

## Custom Hosts

The most valuable integration is usually not text chat but tool-aware agent loops.

Recommended host behavior:

1. Emit events for every tool call and tool result.
2. Emit `plan_update` events when the agent revises its plan.
3. Emit `decision` events when constraints or architecture choices are identified.
4. Call `assessAction()` before executing reads, writes, commands, or network calls.
5. Record the executed action event so the repeat guard can remember it.

## Why the Runtime Stays External

- Vendor compaction remains opaque.
- Different providers keep different parts of history.
- Recovery logic should be auditable and testable outside model prompts.
- The same checkpoint format can drive Claude, Codex, Copilot, Aider, or internal agents later.
