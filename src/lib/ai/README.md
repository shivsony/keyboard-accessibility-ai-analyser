# `lib/ai`

The decision client: builds the prompt from an `AgentAnalysisInput`, calls the
provider, and validates the response into a typed `AgentDecision`.

Holds the user's API key. **Server-only, always.** Never imported by client code —
enforced by ESLint (`eslint.config.mjs`) and `server-only`.

Model output is untrusted input. This module validates; it does not trust.

## Layout

| File                 | Role                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `types.ts`           | `AIProvider`, `AgentAnalysisInput`, `AIProviderError`. No vendor here. |
| `prompt.ts`          | Vendor-neutral prompt and output schema. Reused by any provider.       |
| `openai-provider.ts` | **The only file allowed to import the OpenAI SDK.**                    |
| `mock-provider.ts`   | For tests and local runs. Never a fallback.                            |
| `factory.ts`         | Reads configuration; refuses to run without a key.                     |
| `redact.ts`          | Scrubs credentials out of anything that might be logged.               |

## Adding a provider

1. Implement `AIProvider` in a new file. Import that vendor's SDK there and
   nowhere else.
2. Add the SDK to the ESLint restriction list, with an exception for your file.
3. Add the provider to the `AI_PROVIDER` enum in `lib/shared/env.ts` and to the
   switch in `factory.ts`.
4. Reuse `SYSTEM_PROMPT` and `DECISION_JSON_SCHEMA` — swapping models should
   change the caller, not the agent's behaviour.
5. Parse the response with `safeParseAgentDecision` before returning it.

## Two rules that are not negotiable

**No silent fallback.** If configuration is missing, the audit fails with
`"AI provider is not configured. Set OPENAI_API_KEY."` It does not quietly
substitute the mock. A run that produced fabricated findings would look exactly
like a real one.

**The key never leaves this layer.** Not into an API response, not into a log,
not into an error message, not into the run directory. `redact.ts` is the
backstop, not the plan.
