/**
 * The AI layer.
 *
 * Server-only, and the single place a provider SDK is imported. Callers depend
 * on `AIProvider` and domain types; no vendor type crosses this boundary.
 *
 * `OpenAIProvider` is exported for wiring and tests, but application code
 * should go through `createAIProvider`, which is where configuration — and the
 * refusal to run without it — lives.
 */

export * from "./types";
export * from "./prompt";
export { redactSecrets, safeErrorMessage, REDACTED } from "./redact";
export { createAIProvider, checkAIConfiguration } from "./factory";
export {
  OpenAIProvider,
  type OpenAIChatClient,
  type OpenAIProviderOptions,
} from "./openai-provider";
export {
  MockAIProvider,
  mockContinue,
  mockStop,
  type MockAIProviderOptions,
} from "./mock-provider";
