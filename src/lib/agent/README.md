# `lib/agent`

The orchestration loop and the agent's state.

Owns: run lifecycle, step budget, termination, `AgentState` transitions, and the
**action guard** — the deterministic allowlist check every decision passes through
before a key is pressed.

Depends on: `ai` (decisions), `browser` (execution), `discovery`, `evidence`, `graph`,
`rules`.

Also holds the MVP's audit lifecycle: `audit-registry.ts` (in-memory, one
process, **requires a long-running Node.js server** — no queue, no database) and
`audit-runner.ts`, which wires the browser, the provider, and the report
generator together for one run.

Server-only.
