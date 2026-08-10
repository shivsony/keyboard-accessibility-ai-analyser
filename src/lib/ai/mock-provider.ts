import { AgentDecisionSchema, confidence, type AgentDecision } from "@/lib/shared/domain";

import { AIProviderError, type AgentAnalysisInput, type AIProvider } from "./types";

/**
 * A provider for tests.
 *
 * Exists so the agent loop can be exercised end to end without a network call,
 * an API key, or a bill. It is **not** a fallback: nothing in the application
 * substitutes this when configuration is missing, because an audit that
 * silently produced mock findings would be worse than one that refused to
 * start.
 *
 * It ships in `src/` rather than `tests/` on purpose — integration tests, local
 * development against a real browser, and any future `--dry-run` all want it,
 * and a copy per caller would drift.
 */

export type MockAIProviderOptions = {
  /**
   * Decisions to return, in order.
   *
   * When exhausted, the behaviour of `whenExhausted` applies.
   */
  readonly script?: readonly AgentDecision[];
  /** What to do once the script runs out. Defaults to STOP forever. */
  readonly whenExhausted?: "stop" | "repeat-last" | "throw";
  /** A decision function, for tests that need to react to the input. */
  readonly respond?: (input: AgentAnalysisInput) => AgentDecision;
  /** Milliseconds to wait before answering, to exercise timing paths. */
  readonly latencyMs?: number;
};

const STOP: AgentDecision = Object.freeze({
  decision: "STOP",
  action: null,
  reasoning: "Mock provider has no further scripted decisions.",
  confidence: confidence(1),
  suspectedIssue: null,
  targetElementId: null,
});

/** A CONTINUE that presses the given key. Convenience for building scripts. */
export function mockContinue(action: "TAB" | "SHIFT_TAB" = "TAB"): AgentDecision {
  return AgentDecisionSchema.parse({
    decision: "CONTINUE",
    action,
    reasoning: "Scripted: keep traversing.",
    confidence: 0.8,
    suspectedIssue: null,
    targetElementId: null,
  });
}

export function mockStop(): AgentDecision {
  return STOP;
}

export class MockAIProvider implements AIProvider {
  readonly name = "mock";
  readonly model = "mock";

  #options: MockAIProviderOptions;
  #index = 0;

  /** Every input it was asked about, so tests can assert on what the model saw. */
  readonly received: AgentAnalysisInput[] = [];

  constructor(options: MockAIProviderOptions = {}) {
    this.#options = options;
  }

  /** How many decisions have been requested. */
  get callCount(): number {
    return this.received.length;
  }

  async analyzeObservation(input: AgentAnalysisInput): Promise<AgentDecision> {
    this.received.push(input);

    if (this.#options.latencyMs !== undefined && this.#options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.latencyMs));
    }

    if (this.#options.respond !== undefined) {
      return this.#options.respond(input);
    }

    const script = this.#options.script ?? [];
    const next = script[this.#index];

    if (next !== undefined) {
      this.#index += 1;
      return next;
    }

    switch (this.#options.whenExhausted ?? "stop") {
      case "repeat-last":
        return script.at(-1) ?? STOP;
      case "throw":
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Mock provider script is exhausted",
        );
      default:
        return STOP;
    }
  }
}
