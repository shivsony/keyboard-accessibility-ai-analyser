# `lib/agent`

The orchestration loop and the agent's state.

Owns: run lifecycle, step budget, termination, `AgentState` transitions, and the
**action guard** — the deterministic allowlist check every decision passes through
before a key is pressed.

Depends on: `ai` (decisions), `browser` (execution), `discovery`, `evidence`, `graph`,
`rules`.

Server-only.
