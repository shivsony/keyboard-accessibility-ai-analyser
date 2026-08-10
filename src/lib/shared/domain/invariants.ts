import { isKeyboardAction } from "./keyboard";
import type { AgentState } from "./state";

/**
 * Runtime checks on `AgentState`.
 *
 * The type system guarantees shape; these guarantee *coherence* — the
 * cross-field properties a valid state must have. They exist because every one
 * of them, if violated, produces a finding that cannot be reproduced: a
 * keyboard sequence that does not match what was pressed, evidence pointing at
 * a screenshot that was never taken, an element reported unreachable that
 * discovery never saw.
 *
 * Intended use is a debug assertion after each loop iteration, and a hard gate
 * before anything is written to a report.
 */

export const INVARIANT_CODES = Object.freeze([
  "STEP_COUNT_MISMATCH",
  "STEP_INDICES_NOT_CONTIGUOUS",
  "OBSERVATION_STEPS_NOT_ASCENDING",
  "DUPLICATE_ELEMENT_ID",
  "VISITED_NOT_DISCOVERED",
  "DUPLICATE_VISITED_ID",
  "FOCUSED_ELEMENT_NOT_DISCOVERED",
  "FOCUSED_ELEMENT_NOT_VISITED",
  "KEYBOARD_HISTORY_MISMATCH",
  "KEYBOARD_ACTION_NOT_ALLOWLISTED",
  "GRAPH_EDGE_DANGLING",
  "DUPLICATE_FINDING_ID",
  "FINDING_IN_BOTH_BUCKETS",
  "EVIDENCE_SCREENSHOT_MISSING",
  "EVIDENCE_SEQUENCE_NOT_PREFIX",
  "EVIDENCE_STEP_RANGE_INVERTED",
  "DUPLICATE_SCREENSHOT_ID",
] as const);

export type InvariantCode = (typeof INVARIANT_CODES)[number];

export type InvariantViolation = {
  readonly code: InvariantCode;
  readonly message: string;
};

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

/**
 * Returns every violation rather than throwing on the first.
 *
 * A state that is wrong in three ways should report three problems: fixing them
 * one crash at a time is how a debugging session turns into an afternoon.
 */
export function checkAgentStateInvariants(
  state: AgentState,
): readonly InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const report = (code: InvariantCode, message: string): void => {
    violations.push({ code, message });
  };

  // --- Steps -------------------------------------------------------------

  if (state.currentStep !== state.steps.length) {
    report(
      "STEP_COUNT_MISMATCH",
      `currentStep is ${state.currentStep} but ${state.steps.length} steps are recorded`,
    );
  }

  state.steps.forEach((step, index) => {
    if (step.index !== index) {
      report(
        "STEP_INDICES_NOT_CONTIGUOUS",
        `step at position ${index} has index ${step.index}`,
      );
    }
  });

  // --- Observations ------------------------------------------------------

  state.previousObservations.forEach((observation, index) => {
    const next = state.previousObservations[index + 1];
    if (next !== undefined && next.step <= observation.step) {
      report(
        "OBSERVATION_STEPS_NOT_ASCENDING",
        `observation ${index + 1} has step ${next.step}, not after ${observation.step}`,
      );
    }
  });

  const lastPrevious = state.previousObservations.at(-1);
  if (
    state.currentObservation !== null &&
    lastPrevious !== undefined &&
    state.currentObservation.step <= lastPrevious.step
  ) {
    report(
      "OBSERVATION_STEPS_NOT_ASCENDING",
      `currentObservation step ${state.currentObservation.step} is not after ${lastPrevious.step}`,
    );
  }

  // --- Elements ----------------------------------------------------------

  const discoveredIds = new Set<string>(state.discoveredElements.map((e) => e.id));

  for (const id of duplicates(state.discoveredElements.map((e) => e.id))) {
    report("DUPLICATE_ELEMENT_ID", `element id ${id} is discovered more than once`);
  }

  for (const id of duplicates(state.visitedElementIds)) {
    report("DUPLICATE_VISITED_ID", `element id ${id} is recorded as visited twice`);
  }

  // Visited must be a subset of discovered: the keyboard cannot reach something
  // discovery never registered, and "unreachable" is only provable against a
  // known set.
  for (const id of state.visitedElementIds) {
    if (!discoveredIds.has(id)) {
      report(
        "VISITED_NOT_DISCOVERED",
        `visited element ${id} is not in discoveredElements`,
      );
    }
  }

  if (state.currentFocus.kind === "ELEMENT") {
    const { id } = state.currentFocus.element;
    if (!discoveredIds.has(id)) {
      report(
        "FOCUSED_ELEMENT_NOT_DISCOVERED",
        `focused element ${id} is not in discoveredElements`,
      );
    }
    if (!state.visitedElementIds.includes(id)) {
      report(
        "FOCUSED_ELEMENT_NOT_VISITED",
        `focused element ${id} is not recorded as visited`,
      );
    }
  }

  // --- Keyboard history --------------------------------------------------

  // keyboardHistory must equal the actions actually executed, in order. These
  // are two views of one fact, and the evidence in every finding is built from
  // the first while the second is what really happened.
  const executed = state.steps.flatMap((step) =>
    step.executedAction === null
      ? []
      : [{ step: step.index, action: step.executedAction }],
  );

  if (executed.length !== state.keyboardHistory.length) {
    report(
      "KEYBOARD_HISTORY_MISMATCH",
      `keyboardHistory has ${state.keyboardHistory.length} entries but ${executed.length} actions were executed`,
    );
  } else {
    executed.forEach((entry, index) => {
      const record = state.keyboardHistory[index];
      if (record === undefined) return;
      if (record.action !== entry.action || record.step !== entry.step) {
        report(
          "KEYBOARD_HISTORY_MISMATCH",
          `keyboardHistory[${index}] is ${record.action}@${record.step}, executed was ${entry.action}@${entry.step}`,
        );
      }
    });
  }

  // Defence in depth behind the guard: nothing outside the allowlist may appear
  // in the executed record, even if a bug let it past.
  for (const record of state.keyboardHistory) {
    if (!isKeyboardAction(record.action)) {
      report(
        "KEYBOARD_ACTION_NOT_ALLOWLISTED",
        `keyboardHistory contains non-allowlisted action at step ${record.step}`,
      );
    }
  }

  // --- Navigation graph --------------------------------------------------

  const nodeIds = new Set<string>(state.navigationGraph.nodes.map((n) => n.id));
  for (const edge of state.navigationGraph.edges) {
    if (!nodeIds.has(edge.from)) {
      report("GRAPH_EDGE_DANGLING", `edge at step ${edge.atStep} has unknown from-node`);
    }
    if (!nodeIds.has(edge.to)) {
      report("GRAPH_EDGE_DANGLING", `edge at step ${edge.atStep} has unknown to-node`);
    }
  }

  // --- Screenshots -------------------------------------------------------

  const screenshotIds = new Set<string>(state.screenshots.map((s) => s.id));
  for (const id of duplicates(state.screenshots.map((s) => s.id))) {
    report("DUPLICATE_SCREENSHOT_ID", `screenshot id ${id} appears more than once`);
  }

  // --- Findings ----------------------------------------------------------

  const suspectedIds = state.suspectedFindings.map((f) => f.id);
  const confirmedIds = state.confirmedFindings.map((f) => f.id);

  for (const id of duplicates([...suspectedIds, ...confirmedIds])) {
    report("DUPLICATE_FINDING_ID", `finding id ${id} appears more than once`);
  }

  const confirmedIdSet = new Set<string>(confirmedIds);
  for (const id of suspectedIds) {
    if (confirmedIdSet.has(id)) {
      report(
        "FINDING_IN_BOTH_BUCKETS",
        `finding ${id} is both suspected and confirmed — promotion must move it`,
      );
    }
  }

  const historyActions = state.keyboardHistory.map((record) => record.action);

  for (const finding of state.confirmedFindings) {
    const { evidence } = finding;

    for (const id of evidence.screenshotIds) {
      if (!screenshotIds.has(id)) {
        report(
          "EVIDENCE_SCREENSHOT_MISSING",
          `finding ${finding.id} references screenshot ${id}, which the run did not capture`,
        );
      }
    }

    // Evidence runs from step 0, so it must be a prefix of the run's history.
    // A sequence that starts mid-run cannot be replayed from a cold browser.
    const isPrefix =
      evidence.keyboardSequence.length <= historyActions.length &&
      evidence.keyboardSequence.every(
        (action, index) => historyActions[index] === action,
      );

    if (!isPrefix) {
      report(
        "EVIDENCE_SEQUENCE_NOT_PREFIX",
        `finding ${finding.id} has a keyboard sequence that is not a prefix of the run`,
      );
    }

    if (evidence.steps.to < evidence.steps.from) {
      report(
        "EVIDENCE_STEP_RANGE_INVERTED",
        `finding ${finding.id} has step range ${evidence.steps.from}..${evidence.steps.to}`,
      );
    }
  }

  return violations;
}

export class AgentStateInvariantError extends Error {
  readonly violations: readonly InvariantViolation[];

  constructor(violations: readonly InvariantViolation[]) {
    super(
      `AgentState violates ${violations.length} invariant(s):\n` +
        violations.map((v) => `  - ${v.code}: ${v.message}`).join("\n"),
    );
    this.name = "AgentStateInvariantError";
    this.violations = violations;
  }
}

/** Throws unless the state is coherent. */
export function assertAgentStateInvariants(state: AgentState): void {
  const violations = checkAgentStateInvariants(state);
  if (violations.length > 0) {
    throw new AgentStateInvariantError(violations);
  }
}
