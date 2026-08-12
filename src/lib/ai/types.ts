import type {
  AgentDecision,
  AgentObservation,
  AuditId,
  ElementId,
  InteractiveElement,
  InvestigationContext,
  KeyboardActionRecord,
  StepIndex,
  SuspectedFinding,
  Url,
} from "@/lib/shared/domain";

/**
 * The AI layer's public surface.
 *
 * Nothing here mentions a vendor. The rest of the application depends on
 * `AIProvider` and domain types only, so adding a second provider — or running
 * the whole loop against a mock — is a local change rather than a rewrite.
 *
 * The OpenAI SDK is imported in exactly one file (`openai-provider.ts`), and
 * ESLint enforces that.
 */

/**
 * Everything the model is shown before it decides.
 *
 * This is the observation plus the history that makes it interpretable: a
 * single focus position says nothing about tab order, and "have I been here
 * before" is the question that separates a cycle from progress.
 *
 * Every field is page-controlled or derived from page content. It is data for
 * the model to read, never instruction to follow (SECURITY.md §1).
 */
export type AgentAnalysisInput = {
  readonly auditId: AuditId;
  readonly url: Url;
  readonly step: StepIndex;

  /** What the agent sees now. */
  readonly observation: AgentObservation;
  /** Earlier observations, oldest first. Windowed by the provider if long. */
  readonly previousObservations: readonly AgentObservation[];

  readonly discoveredElements: readonly InteractiveElement[];
  readonly visitedElementIds: readonly ElementId[];
  readonly keyboardHistory: readonly KeyboardActionRecord[];
  /** The traversal so far, rendered as "Logo --TAB--> Search". */
  readonly navigationSummary: string;

  /** Hypotheses the agent is still testing. */
  readonly suspectedFindings: readonly SuspectedFinding[];

  /**
   * The line of enquiry currently being pursued, if any.
   *
   * Its presence is what tells the model it is mid-investigation rather than
   * exploring — without it, an agent has no memory of the question it was
   * trying to answer two keypresses ago.
   */
  readonly investigation: InvestigationContext | null;

  /** Screenshot bytes for the current state, when the model can see images. */
  readonly screenshot: Uint8Array | null;

  /** How many steps remain in the budget. Informs when to STOP. */
  readonly stepsRemaining: number;

  /**
   * Why the model is being consulted, when the traversal policy escalated.
   *
   * Null in `every-step` mode. Naming the juncture lets the prompt ask a narrow
   * question — "is this unreached control a defect?" — rather than re-deriving
   * the situation from scratch each time.
   */
  readonly decisionPoint?: string | null;

  /**
   * Findings already reported and refused, with the validator's reasons.
   *
   * Shown to the model so it does not file the same rejected report again. A
   * real run spent six consecutive calls doing exactly that.
   */
  readonly rejectedClaims?: readonly { type: string; reasons: readonly string[] }[];
};

/**
 * A source of decisions.
 *
 * One method, because the agent asks one question: given everything known,
 * what should happen next? A provider that offered more — "summarize this",
 * "classify that" — would invite the AI back into roles the architecture keeps
 * deterministic.
 */
export interface AIProvider {
  /** Identifies the provider in logs and reports. Never includes a key. */
  readonly name: string;
  /** The model in use, for the run record. */
  readonly model: string;
  /**
   * Whether the agent actually sees the page.
   *
   * On the interface rather than hidden in an implementation, because a report
   * should be readable differently depending on the answer: an agent working
   * from the accessibility tree alone cannot notice that a control is visually
   * first but focused last.
   */
  readonly multimodal: boolean;

  /**
   * Returns a validated decision, or throws.
   *
   * Implementations must parse the model's response against
   * `AgentDecisionSchema` before returning it. A provider that returns
   * unvalidated output would put untrusted text where the guard expects a
   * decision.
   */
  analyzeObservation(
    input: AgentAnalysisInput,
    options?: AnalyzeOptions,
  ): Promise<AgentDecision>;
}

export type AnalyzeOptions = {
  readonly signal?: AbortSignal;
};

export const AI_ERROR_CODES = Object.freeze([
  /** No key, unknown provider, or otherwise unusable configuration. */
  "NOT_CONFIGURED",
  /** The provider rejected the request or was unreachable. */
  "REQUEST_FAILED",
  /** The response did not parse into a valid decision, after retries. */
  "INVALID_RESPONSE",
  /**
   * The screenshot could not be submitted.
   *
   * Its own code because the remedy differs: the run is not multimodal any
   * more, and continuing text-only would quietly change what the agent is
   * capable of noticing.
   */
  "IMAGE_SUBMISSION_FAILED",
  /** The caller aborted. */
  "CANCELLED",
] as const);

export type AIErrorCode = (typeof AI_ERROR_CODES)[number];

/**
 * A failure in the AI layer.
 *
 * `message` is scrubbed before it reaches here. Provider errors routinely echo
 * request headers, and an error string ends up in logs and bug reports
 * (SECURITY.md §4).
 */
export class AIProviderError extends Error {
  readonly code: AIErrorCode;

  constructor(code: AIErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AIProviderError";
    this.code = code;
  }
}

export function isAIProviderError(error: unknown): error is AIProviderError {
  return error instanceof AIProviderError;
}

/** The message the brief requires, verbatim, in one place. */
export const NOT_CONFIGURED_MESSAGE =
  "AI provider is not configured. Set OPENAI_API_KEY.";
