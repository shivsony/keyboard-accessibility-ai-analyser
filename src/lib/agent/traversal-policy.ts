import { observeFindings } from "@/lib/rules";
import {
  type AgentState,
  type FindingType,
  type KeyboardAction,
  type TerminationReason,
} from "@/lib/shared/domain";

/**
 * The deterministic traversal policy.
 *
 * A keyboard sweep is not an interesting decision. There are two keys, and on
 * almost every step the right one is Tab — the model was being asked to confirm
 * that over and over, at roughly ten thousand tokens a time, while
 * `lib/rules/observations.ts` already knew everything worth knowing about the
 * page from the trace.
 *
 * So code sweeps, and the model is consulted where a judgement is actually
 * required: something looks wrong and somebody has to decide whether it is.
 *
 * This function is pure and takes no provider. That is deliberate — the
 * question "what should happen next?" is now answerable, and testable, without
 * a network call.
 */

/** Why the model is being consulted. Recorded so a run can be explained. */
export type DecisionPoint =
  /** The trace supports a finding type nobody has judged yet. */
  | "CANDIDATE_FINDING"
  /** Every reachable control has been reached; is there anything to report? */
  | "TRAVERSAL_COMPLETE"
  /** The same state keeps coming back and the sweep is learning nothing. */
  | "STUCK";

export type PolicyOutcome =
  /** Execute this key. No model call. */
  | { readonly kind: "SWEEP"; readonly action: KeyboardAction; readonly reason: string }
  /** Ask the model. One call. */
  | {
      readonly kind: "ESCALATE";
      readonly decisionPoint: DecisionPoint;
      readonly issueType: FindingType | null;
    }
  /** End the run. No model call. */
  | { readonly kind: "COMPLETE"; readonly reason: TerminationReason };

export type PolicyOptions = {
  /**
   * Finding types already put to the model.
   *
   * Without this the policy would escalate the same candidate on every step —
   * which is exactly the loop that made a real run spend six consecutive calls
   * reporting the same rejected thing.
   */
  readonly adjudicated: ReadonlySet<FindingType>;
  /** Consecutive identical state signatures seen so far. */
  readonly repeats: number;
  readonly repeatedStateThreshold: number;
};

/**
 * Findings that only mean something once the sweep has covered the page.
 *
 * "This control has not been reached" is true of everything at step one. It
 * becomes evidence only after the traversal has had the opportunity — a full
 * lap, or a sweep that has visibly stalled. The other two types are events:
 * focus leaving a modal, or a trap with no way out, are conclusive the moment
 * they are observed.
 */
const NEEDS_FULL_SWEEP: ReadonlySet<FindingType> = new Set([
  "UNREACHABLE_ELEMENT",
  "NO_KEYBOARD_REACHABLE_CONTROLS",
  "SUSPICIOUS_FOCUS_ORDER",
]);

/**
 * Whether focus has completed a lap.
 *
 * Tabbing off the end of the document and back round is how a tab order ends.
 * It is the signal that the sweep has seen what there is to see, as opposed to
 * merely not having got there yet.
 */
function hasWrappedAround(state: AgentState): boolean {
  return state.navigationGraph.nodes.some((node) => node.focusKind === "OUTSIDE_PAGE");
}

/**
 * Decides the next move without consulting a model.
 *
 * Order matters. Candidate findings come first because they are the only reason
 * the audit exists; completion is checked before sweeping so a finished
 * traversal does not spend another keypress proving it.
 */
export function decideNextMove(state: AgentState, options: PolicyOptions): PolicyOutcome {
  // Nothing observed yet: there is only one sensible move.
  if (state.currentObservation === null) {
    return { kind: "SWEEP", action: "TAB", reason: "Beginning the traversal." };
  }

  const stuck = options.repeats >= options.repeatedStateThreshold;
  const covered = hasWrappedAround(state) || stuck;

  // A candidate the model has not judged. This is what the AI is for.
  //
  // Coverage-dependent types are held back until the sweep has had its chance:
  // at step one, every control is "unreached", and escalating then would ask
  // the model to judge a traversal that has not happened yet. The model used to
  // supply that patience; now the policy does.
  const candidate = observeFindings(state)
    .map((finding) => finding.details.type)
    .find(
      (type) =>
        !options.adjudicated.has(type) && (covered || !NEEDS_FULL_SWEEP.has(type)),
    );

  if (candidate !== undefined) {
    return { kind: "ESCALATE", decisionPoint: "CANDIDATE_FINDING", issueType: candidate };
  }

  // The lap is done and nothing is left to judge.
  //
  // Note this does not require everything to have been *reached*: a control the
  // keyboard cannot get to stays unreached forever, so waiting for it would
  // spend the whole budget re-walking a page whose answer is already known. A
  // second lap teaches nothing — anything still unreached after the first has
  // either been judged already or is not a candidate at all.
  if (hasWrappedAround(state)) {
    return { kind: "COMPLETE", reason: "AGENT_STOPPED" };
  }

  // Going in circles with candidates already judged: stop rather than pay for
  // the model to tell us the same thing again.
  if (stuck) {
    return { kind: "COMPLETE", reason: "REPEATED_STATE" };
  }

  return {
    kind: "SWEEP",
    action: "TAB",
    reason: "Sweeping forward through the tab order.",
  };
}
