# Security Policy

## Supported Versions

The latest minor release is the supported version for security fixes.

## Reporting

If you find a security issue:

1. Do not open a public exploit issue immediately.
2. Provide a minimal reproduction and impact summary.
3. Include the affected command, adapter, or data path.

## Current Risk Areas

- provider API key handling in host environments
- prompt injection through untrusted tool output
- unsafe replay of side-effectful actions
- adapter-specific serialization bugs

The runtime is designed to reduce accidental action replay, but hosts remain responsible for sandboxing and permission policy.
