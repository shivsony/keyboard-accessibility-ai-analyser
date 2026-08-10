import {
  ConfidenceSchema,
  FindingTypeSchema,
  findingId as toFindingId,
  keyboardSequence,
  type AgentState,
  type ConfirmedFinding,
  type ElementId,
  type FindingEvidence,
  type FindingType,
  type KeyboardAction,
  type ReportedIssue,
  type StepIndex,
  type SuspectedFinding,
} from "@/lib/shared/domain";

import { hasObservationOfType, observeFindings } from "./observations";

/**
 * The finding validator.
 *
 * **A suspicion is not a finding.** The model supplies reasoning, severity, and
 * the words a developer will read; the browser trace supplies every fact. Where
 * the two disagree, the trace wins — not as a tiebreak, but because a report
 * that misstates what happened is worse than no report: somebody follows the
 * steps, sees something else, and stops trusting the rest of it.
 *
 * Nothing reaches CONFIRMED without a matching observation *and* a trace that
 * supports each claim made about it (ARCHITECTURE.md §4).
 */

export const REJECTION_REASONS = Object.freeze([
  /** The finding names a control discovery never saw. */
  "ELEMENT_NOT_DISCOVERED",
  /** It claims focus reached an element the trace never focused. */
  "ELEMENT_NOT_FOCUSED",
  /** It claims focus *skipped* an element the trace shows was reached. */
  "ELEMENT_WAS_REACHED",
  /** Nothing was pressed, so there is no sequence to reproduce. */
  "NO_KEYBOARD_SEQUENCE",
  /** The claimed sequence is not what the run actually pressed. */
  "SEQUENCE_NOT_IN_TRACE",
  /** A claimed focus transition does not appear in the navigation graph. */
  "FOCUS_TRANSITION_NOT_OBSERVED",
  /** No screenshot covers the steps the finding spans. */
  "NO_SCREENSHOT_EVIDENCE",
  /** Not one of the supported finding types. */
  "UNSUPPORTED_ISSUE_TYPE",
  /** Confidence is missing or outside 0–1. */
  "CONFIDENCE_OUT_OF_RANGE",
  /** The trace shows no sign of the pattern being claimed. */
  "NO_CORROBORATING_OBSERVATION",
] as const);

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type ValidationProblem = {
  readonly reason: RejectionReason;
  readonly detail: string;
};

/**
 * What the model asserts.
 *
 * The claimed sequence and focus path are optional. When the model states them
 * they are checked against the trace and a mismatch rejects the finding; when
 * it does not, the validator builds them from the trace itself. Either way the
 * evidence attached to a confirmed finding comes from the recording, never from
 * the claim.
 */
export type FindingClaim = {
  readonly issue: ReportedIssue;
  readonly reason: string;
  readonly confidence: number;
  readonly step: StepIndex;
  readonly targetElementId?: ElementId | null;
  readonly claimedKeyboardSequence?: readonly KeyboardAction[] | null;
  readonly claimedFocusElementIds?: readonly ElementId[] | null;
};

export type ValidationResult =
  | {
      readonly outcome: "CONFIRMED";
      readonly finding: ConfirmedFinding;
      readonly problems: readonly [];
    }
  | {
      readonly outcome: "REJECTED";
      readonly problems: readonly ValidationProblem[];
    };

export class FindingValidator {
  #state: AgentState;

  constructor(state: AgentState) {
    this.#state = state;
  }

  /**
   * Checks a claim against the trace.
   *
   * Every check runs — the result lists all the problems, not the first. A
   * finding rejected for three reasons is a different situation from one
   * rejected for a single near-miss, and telling them apart matters when
   * deciding whether the model is confused or the page is unusual.
   */
  validate(claim: FindingClaim): ValidationResult {
    const problems: ValidationProblem[] = [];
    const state = this.#state;

    const add = (reason: RejectionReason, detail: string): void => {
      problems.push({ reason, detail });
    };

    // --- Issue type -------------------------------------------------------

    if (!FindingTypeSchema.safeParse(claim.issue.type).success) {
      add(
        "UNSUPPORTED_ISSUE_TYPE",
        `${String(claim.issue.type)} is not a finding type this tool reports`,
      );
    }

    // --- Confidence -------------------------------------------------------

    if (!ConfidenceSchema.safeParse(claim.confidence).success) {
      add(
        "CONFIDENCE_OUT_OF_RANGE",
        `confidence ${String(claim.confidence)} is not a number between 0 and 1`,
      );
    }

    // --- Keyboard sequence ------------------------------------------------

    const actual = keyboardSequence(state);

    if (actual.length === 0) {
      add(
        "NO_KEYBOARD_SEQUENCE",
        "the run pressed no keys, so there is nothing to reproduce",
      );
    }

    // A claimed sequence must be a prefix of what was pressed. Evidence runs
    // from step 0, so a sequence that starts mid-run cannot be replayed from a
    // cold browser — and one that contains keys the run never pressed is
    // fabricated.
    if (claim.claimedKeyboardSequence != null) {
      const claimed = claim.claimedKeyboardSequence;
      const isPrefix =
        claimed.length <= actual.length &&
        claimed.every((action, index) => actual[index] === action);

      if (!isPrefix) {
        add(
          "SEQUENCE_NOT_IN_TRACE",
          `claimed sequence [${claimed.join(", ")}] is not what the run pressed [${actual.join(", ")}]`,
        );
      }
    }

    // --- Focus claims -----------------------------------------------------

    const visited = new Set<string>(state.visitedElementIds);
    const discovered = new Set<string>(state.discoveredElements.map((e) => e.id));

    if (claim.claimedFocusElementIds != null) {
      for (const elementId of claim.claimedFocusElementIds) {
        if (!discovered.has(elementId)) {
          add(
            "ELEMENT_NOT_DISCOVERED",
            `claims focus reached ${elementId}, which discovery never saw`,
          );
          continue;
        }

        if (!visited.has(elementId)) {
          add(
            "ELEMENT_NOT_FOCUSED",
            `claims focus reached ${elementId}, but the trace never focused it`,
          );
        }
      }
    }

    // --- The element the finding is about ---------------------------------

    const target = this.#targetOf(claim);

    if (target !== null) {
      if (!discovered.has(target)) {
        add(
          "ELEMENT_NOT_DISCOVERED",
          `the finding is about ${target}, which discovery never saw`,
        );
      } else if (claim.issue.type === "UNREACHABLE_ELEMENT" && visited.has(target)) {
        // The specific contradiction this finding type invites: claiming a
        // control is unreachable when the trace shows focus landing on it.
        add(
          "ELEMENT_WAS_REACHED",
          `claims ${target} is unreachable, but the trace focused it`,
        );
      }
    }

    // --- Screenshot evidence ----------------------------------------------

    if (state.screenshots.length === 0) {
      add("NO_SCREENSHOT_EVIDENCE", "the run captured no screenshots");
    }

    // --- Corroboration ----------------------------------------------------

    if (!hasObservationOfType(state, claim.issue.type)) {
      add(
        "NO_CORROBORATING_OBSERVATION",
        `the trace shows no ${claim.issue.type}; the model's word alone is not enough`,
      );
    }

    if (problems.length > 0) return { outcome: "REJECTED", problems };

    return {
      outcome: "CONFIRMED",
      finding: this.#confirm(claim),
      problems: [],
    };
  }

  /**
   * Promotes a suspicion the agent raised earlier.
   *
   * The same checks, driven from a `SuspectedFinding` rather than a fresh
   * claim — so a hypothesis carried across several steps is held to exactly
   * the standard a direct report would be.
   */
  validateSuspected(suspected: SuspectedFinding, issue: ReportedIssue): ValidationResult {
    return this.validate({
      issue,
      reason: suspected.reasoning,
      confidence: suspected.confidence,
      step: suspected.detectedAtStep,
      targetElementId: elementIdFromDetails(suspected.details),
    });
  }

  #targetOf(claim: FindingClaim): ElementId | null {
    if (claim.targetElementId != null) return claim.targetElementId;

    // For an unreachable-element claim with no named target, the observation
    // has one: the element the trace shows was never reached.
    if (claim.issue.type === "UNREACHABLE_ELEMENT") {
      const observed = observeFindings(this.#state).find(
        (finding) => finding.details.type === "UNREACHABLE_ELEMENT",
      );

      if (observed?.details.type === "UNREACHABLE_ELEMENT") {
        return observed.details.elementId;
      }
    }

    return null;
  }

  /**
   * Builds the confirmed finding.
   *
   * Every factual field comes from the trace: the keyboard sequence, the focus
   * path, the screenshots, the DOM and ARIA captures. The model contributes the
   * severity, the title, the description, and its reasoning — the interpretation,
   * and nothing else.
   */
  #confirm(claim: FindingClaim): ConfirmedFinding {
    const state = this.#state;
    const observation = state.currentObservation;

    const evidence: FindingEvidence = {
      keyboardSequence: keyboardSequence(state),
      focusSequence: state.steps.map((step) => step.observation.focus),
      screenshotIds: state.screenshots.map((screenshot) => screenshot.id),
      domEvidence: observation?.dom ?? emptyDom(),
      ariaEvidence: observation?.aria ?? emptyAria(),
      steps: { from: 0, to: Math.max(0, state.currentStep - 1) },
    };

    const details = this.#detailsFor(claim);

    return {
      id: toFindingId(`confirmed-${claim.issue.type}-${claim.step}`),
      status: "CONFIRMED",
      details,
      reasoning: claim.reason,
      confidence: ConfidenceSchema.parse(claim.confidence),
      detectedAtStep: claim.step,
      detectedAt: new Date(0).toISOString(),
      severity: claim.issue.severity,
      evidence,
      likelyCause: claim.issue.description,
      suggestedFix: claim.issue.title,
      confirmedAtStep: state.currentStep,
    };
  }

  /**
   * The type-specific particulars, taken from the observation.
   *
   * Not from the claim: the model says *what kind* of problem it is, and the
   * trace says which elements, which steps, and which cycle.
   */
  #detailsFor(claim: FindingClaim): ConfirmedFinding["details"] {
    const observed = observeFindings(this.#state).find(
      (finding) => finding.details.type === claim.issue.type,
    );

    if (observed !== undefined) return observed.details;

    // Unreachable: the validator has already established the target exists.
    const target = this.#targetOf(claim);

    return target === null
      ? {
          type: "NO_KEYBOARD_REACHABLE_CONTROLS",
          discoveredCount: Math.max(1, this.#state.discoveredElements.length),
        }
      : { type: "UNREACHABLE_ELEMENT", elementId: target };
  }
}

function elementIdFromDetails(details: SuspectedFinding["details"]): ElementId | null {
  return details.type === "UNREACHABLE_ELEMENT" ? details.elementId : null;
}

function emptyDom(): FindingEvidence["domEvidence"] {
  return {
    summary: "",
    nodeCount: 0,
    truncated: false,
    capturedAt: new Date(0).toISOString(),
  };
}

function emptyAria(): FindingEvidence["ariaEvidence"] {
  return {
    snapshot: "",
    nodeCount: 0,
    truncated: false,
    capturedAt: new Date(0).toISOString(),
  };
}

/** Every supported finding type. Exported so callers can check without parsing. */
export const SUPPORTED_FINDING_TYPES: readonly FindingType[] = Object.freeze([
  ...FindingTypeSchema.options,
]);
