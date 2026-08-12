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
 * Taken from an *observation*, whose `interactiveElements` are in document
 * order — not from `discoveredElements`, which accumulates in the order things
 * were first seen. On a static page the two agree. On a page that reveals
 * controls as you go they do not, and using the accumulated list would report a
 * scrambled focus order on every disclosure widget and menu.
 *
 * The richest observation is used: the one that saw the most of the page at
 * once, which is the only view in which the compared controls all coexisted.
 *
 * This is the only "expected order" the system will assert. It is a fact about
 * the document, never an intuition about how the page was meant to work.
 */
export function domOrderOfVisited(state: AgentState): readonly ElementId[] {
  const visited = new Set<string>(state.visitedElementIds);

  const observations =
    state.currentObservation === null
      ? state.steps.map((step) => step.observation)
      : [...state.steps.map((step) => step.observation), state.currentObservation];

  const fullest = observations.reduce<AgentState["currentObservation"]>(
    (best, observation) =>
      best === null ||
      observation.interactiveElements.length > best.interactiveElements.length
        ? observation
        : best,
    null,
  );

  const source = fullest?.interactiveElements ?? state.discoveredElements;

  return source.filter((element) => visited.has(element.id)).map((element) => element.id);
}

/**
 * Elements the keyboard never reached **and which are still on the page**.
 *
 * The presence check is the difference between a defect and a false positive.
 * A control that appeared, was passed over, and then removed from the DOM is
 * gone — not unreachable. Pages that reveal controls on focus do this on every
 * traversal, and reporting them would put an issue on every disclosure widget,
 * menu and accordion ever built.
 *
 * Presence is judged from the most recent observation, because that is the only
 * state anybody can go and check.
 */
export function unreachedElementIds(state: AgentState): readonly ElementId[] {
  const stillPresent =
    state.currentObservation === null
      ? null
      : new Set<string>(
          state.currentObservation.interactiveElements.map((element) => element.id),
        );

  return unvisitedDiscoveredElements(state.navigationGraph, state.discoveredElements)
    .filter((element) => !state.visitedElementIds.includes(element.id))
    .filter((element) => stillPresent === null || stillPresent.has(element.id))
    .filter((element) => isExpectedToBeReachable(element))
    .map((element) => element.id);
}

/**
 * Whether a control *should* have been reachable.
 *
 * Some elements are unfocusable on purpose, and reporting them is worse than
 * missing a real issue: a reader who is told a disabled button is a defect
 * stops believing the findings that are real.
 *
 * - `disabled` is the platform's own way of saying "not available now".
 * - Invisible elements are not operable by anyone, so they are not a keyboard
 *   problem specifically.
 * - `tabindex="-1"` is a deliberate removal from the tab order, used for
 *   controls reached by other means — a roving tabindex, or programmatic focus.
 */
function isExpectedToBeReachable(element: {
  disabled: boolean;
  visible: boolean;
  tabIndex: number | null;
}): boolean {
  if (element.disabled) return false;
  if (!element.visible) return false;
  if (element.tabIndex !== null && element.tabIndex < 0) return false;

  return true;
}

/**
 * Steps where focus left a modal context for content behind it.
 *
 * **Only the modal case.** An earlier version also flagged focus leaving the
 * document while controls remained unreached, and it was wrong: tabbing past
 * the last control into browser chrome is what every correct page does at the
 * end of its tab order, and with Tab alone there is no way to tell that apart
 * from an escape. It fired on correct pages, which is the failure that gets a
 * tool switched off.
 *
 * Leaving a dialog is different and checkable: the element focused before was
 * inside a modal, the one focused after is not. A keyboard user who tabs out of
 * a dialog has lost their place with no way of knowing it.
 *
 * The cost of this narrowing is real: focus thrown out of the document by a
 * rogue handler mid-traversal is not detected. That needs more than two keys.
 */
export function focusEscapedAtSteps(state: AgentState): readonly number[] {
  const steps: number[] = [];

  const observations = state.steps.map((step) => step.observation);
  if (state.currentObservation !== null) observations.push(state.currentObservation);

  observations.forEach((observation, index) => {
    const previous = observations[index - 1];
    if (previous === undefined) return;

    const wasInModal =
      previous.focus.kind === "ELEMENT" && previous.focus.element.inModal;
    if (!wasInModal) return;

    const stillInModal =
      observation.focus.kind === "ELEMENT" && observation.focus.element.inModal;

    if (!stillInModal) steps.push(observation.step);
  });

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
  // Compared only when the document view contains every control the traversal
  // reached. If some had already vanished, the two lists describe different
  // pages and their difference means nothing.
  if (
    observedOrder.length > 1 &&
    domOrder.length === observedOrder.length &&
    observedOrder.join("|") !== domOrder.join("|")
  ) {
    record("SUSPICIOUS_FOCUS_ORDER", {
      type: "SUSPICIOUS_FOCUS_ORDER",
      observedOrder,
      expectedOrder: domOrder,
    });
  }

  for (const step of focusEscapedAtSteps(state)) {
    record("UNEXPECTED_FOCUS_LEAVING_PAGE", {
      type: "UNEXPECTED_FOCUS_LEAVING_PAGE",
      atStep: step,
      lastElementId: null,
    });
  }

  // Two things separate a trap from a tab order wrapping around, and both are
  // needed:
  //
  //  - It keeps the user away from something. A cycle that excludes nothing is
  //    just a complete traversal returning to the start.
  //  - Focus never crosses the document boundary. Tabbing off the end of a page
  //    into browser chrome and back round is normal; a trap never gets there,
  //    which is precisely what makes it a trap.
  //
  // Without the second condition every page with one unreachable control also
  // reports a phantom focus cycle.
  // OUTSIDE_PAGE only. The document body is where focus *starts* on most pages,
  // so counting it would treat every traversal as having escaped before it
  // began — and would suppress the very traps this rule exists to find.
  const escapedTheDocument = state.navigationGraph.nodes.some(
    (node) => node.focusKind === "OUTSIDE_PAGE",
  );

  if (unreached.length > 0 && !escapedTheDocument) {
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
  }

  return observed;
}

/** Whether the trace supports a claim of this type at all. */
export function hasObservationOfType(state: AgentState, type: FindingType): boolean {
  return observeFindings(state).some((finding) => finding.details.type === type);
}
