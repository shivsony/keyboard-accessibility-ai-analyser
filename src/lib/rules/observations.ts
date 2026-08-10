import { detectCycles, unvisitedDiscoveredElements } from "@/lib/graph";
import {
  findingId as toFindingId,
  type AgentState,
  type ElementId,
  type FindingType,
  type ObservedFinding,
} from "@/lib/shared/domain";

/**
 * What the browser trace shows, with no model involved.
 *
 * These are the deterministic signals behind each finding type. They answer
 * "is this pattern present in the traversal?" — never "is this a defect?".
 * A control the traversal never reached might be unreachable, or the run might
 * have stopped early; that judgement belongs to the model, and the pairing of
 * the two is what the validator checks.
 *
 * Everything here is derived from recorded state, so the same trace always
 * produces the same observations. That is what makes a confirmed finding
 * reproducible rather than merely persuasive.
 */

/** The focus order the traversal actually produced, in order of first arrival. */
export function observedFocusOrder(state: AgentState): readonly ElementId[] {
  return state.visitedElementIds;
}

/**
 * DOM order, restricted to the controls the traversal reached.
 *
 * Discovery walks the document in order, so `discoveredElements` is DOM order.
 * Comparing the reached subset against it is the only "expected order" the
 * system will assert — it is a fact about the document, not an intuition about
 * how the page was meant to work.
 */
export function domOrderOfVisited(state: AgentState): readonly ElementId[] {
  const visited = new Set<string>(state.visitedElementIds);

  return state.discoveredElements
    .filter((element) => visited.has(element.id))
    .map((element) => element.id);
}

/** Elements discovery found that the keyboard never reached. */
export function unreachedElementIds(state: AgentState): readonly ElementId[] {
  return unvisitedDiscoveredElements(state.navigationGraph, state.discoveredElements)
    .filter((element) => !state.visitedElementIds.includes(element.id))
    .map((element) => element.id);
}

/** Steps at which focus left the document. */
export function focusLeftPageAtSteps(state: AgentState): readonly number[] {
  const steps: number[] = [];

  for (const step of state.steps) {
    if (step.observation.focus.kind === "OUTSIDE_PAGE") steps.push(step.index);
  }

  if (state.currentFocus.kind === "OUTSIDE_PAGE") {
    steps.push(state.currentStep);
  }

  return [...new Set(steps)];
}

/**
 * Every pattern the trace supports, as observed findings.
 *
 * Emitted regardless of what the model thinks. A run that produces observations
 * and no suspicions is a page the agent walked without noticing anything — and
 * the observations are still worth having, because they are what a later
 * suspicion gets checked against.
 */
export function observeFindings(state: AgentState): readonly ObservedFinding[] {
  const at = state.steps.at(-1)?.completedAt ?? new Date(0).toISOString();
  const step = state.currentStep;
  const observed: ObservedFinding[] = [];

  const record = (type: FindingType, details: ObservedFinding["details"]): void => {
    observed.push({
      id: toFindingId(`observed-${type}-${step}`),
      status: "OBSERVED",
      details,
      observedAtStep: step,
      observedAt: at,
    });
  };

  const unreached = unreachedElementIds(state);

  // The page offers controls and the keyboard reached none of them. Checked
  // first because it subsumes the per-element case.
  if (state.discoveredElements.length > 0 && state.visitedElementIds.length === 0) {
    record("NO_KEYBOARD_REACHABLE_CONTROLS", {
      type: "NO_KEYBOARD_REACHABLE_CONTROLS",
      discoveredCount: state.discoveredElements.length,
    });
  } else {
    for (const elementId of unreached) {
      record("UNREACHABLE_ELEMENT", { type: "UNREACHABLE_ELEMENT", elementId });
    }
  }

  const observedOrder = observedFocusOrder(state);
  const domOrder = domOrderOfVisited(state);

  // Divergence between the order focus arrived in and the order the document
  // declares. Only meaningful once more than one control has been reached.
  if (observedOrder.length > 1 && observedOrder.join("|") !== domOrder.join("|")) {
    record("SUSPICIOUS_FOCUS_ORDER", {
      type: "SUSPICIOUS_FOCUS_ORDER",
      observedOrder,
      expectedOrder: domOrder,
    });
  }

  for (const step of focusLeftPageAtSteps(state)) {
    record("UNEXPECTED_FOCUS_LEAVING_PAGE", {
      type: "UNEXPECTED_FOCUS_LEAVING_PAGE",
      atStep: step,
      lastElementId: null,
    });
  }

  for (const cycle of detectCycles(state.navigationGraph)) {
    const inCycle = new Set<string>(
      cycle.nodes.map((nodeId) => nodeId.replace(/^element:/, "")),
    );

    record("SUSPICIOUS_FOCUS_CYCLE", {
      type: "SUSPICIOUS_FOCUS_CYCLE",
      cycleElementIds: state.visitedElementIds.filter((id) => inCycle.has(id)),
      excludedElementIds: unreached,
    });
  }

  return observed;
}

/** Whether the trace supports a claim of this type at all. */
export function hasObservationOfType(state: AgentState, type: FindingType): boolean {
  return observeFindings(state).some((finding) => finding.details.type === type);
}
