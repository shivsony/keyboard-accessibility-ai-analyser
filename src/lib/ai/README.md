# `lib/ai`

The decision client: builds the prompt from an `AgentObservation`, calls the provider,
and validates the response into a typed `AgentDecision`.

Holds the user's API key. **Server-only, always.** Never imported by client code —
enforced by ESLint (`eslint.config.mjs`) and `server-only`.

Model output is untrusted input. This module validates; it does not trust.
