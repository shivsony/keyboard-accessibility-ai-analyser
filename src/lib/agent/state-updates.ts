import { nodeIdForFocus, recordTransition } from "@/lib/graph";
import {
  focusedElement,
  type AgentObservation,
  type AgentState,
  type AgentStep,
  type FocusState,
  type InteractiveElement,
  type KeyboardAction,
  type ScreenshotEvidence,
  type StepIndex,
  type SuspectedFinding,
  type Timestamp,
} from "@/lib/shared/domain";

/**
 * The agent's memory, as pure transitions.
 *
 * Every function takes a state and returns a new one. The loop is the only
 * thing that sequences them, which keeps the interesting question — "what does
 * the agent know after this step?" — answerable without a browser, a model, or a
 * clock.
 *
 * Each transition preserves the invariants in `domain/invariants.ts`. The loop
 * asserts them after every step in development, so a transition that breaks one
 * fails immediately rather than surfacing later as an unreproducible finding.
 */

/**
 * Folds an observation into memory.
 *
 * The previous "current" observation moves into history, newly seen elements
 * are merged into the discovered set, and focus landing on an element records
 * both the element and the visit — an element focused but never discovered
 * would violate the invariant that visited is a subset of discovered.
 */
export function applyObservation(
  state: AgentState,
  observation: AgentObservation,
): AgentState {
  const discovered = mergeElements(
    state.discoveredElements,
    observation.interactiveElements,
  );
  const focused = focusedElement(observation.focus);

  const withFocused =
    focused === null ? discovered : mergeElements(discovered, [focused]);

  const visited =
    focused === null || state.visitedElementIds.includes(focused.id)
      ? state.visitedElementIds
      : [...state.visitedElementIds, focused.id];

  return {
    ...state,
    previousObservations:
      state.currentObservation === null
        ? state.previousObservations
        : [...state.previousObservations, state.currentObservation],
    currentObservation: observation,
    currentFocus: observation.focus,
    discoveredElements: withFocused,
    visitedElementIds: visited,
  };
}

/**
 * Merges newly seen elements into the discovered set.
 *
 * Existing records are kept rather than replaced, so `discoveredAtStep` stays
 * the step the element was *first* seen. That is the number an evidence path is
 * measured against; overwriting it each observation would make every element
 * look like it appeared at the end of the run.
 */
function mergeElements(
  existing: readonly InteractiveElement[],
  incoming: readonly InteractiveElement[],
): readonly InteractiveElement[] {
  const known = new Set<string>(existing.map((element) => element.id));
  const additions = incoming.filter((element) => !known.has(element.id));

  return additions.length === 0 ? existing : [...existing, ...additions];
}

/** Registers a screenshot so evidence can reference it. */
export function applyScreenshot(
  state: AgentState,
  screenshot: ScreenshotEvidence,
): AgentState {
  if (state.screenshots.some((existing) => existing.id === screenshot.id)) return state;

  return { ...state, screenshots: [...state.screenshots, screenshot] };
}

/**
 * Records an executed keypress: the keyboard history and the graph edge.
 *
 * Both are updated together because they describe one event. Letting them drift
 * apart is what the `KEYBOARD_HISTORY_MISMATCH` invariant exists to catch.
 */
export function applyTransition(
  state: AgentState,
  transition: {
    from: FocusState;
    to: FocusState;
    action: KeyboardAction;
    step: StepIndex;
    at: Timestamp;
  },
): AgentState {
  return {
    ...state,
    keyboardHistory: [
      ...state.keyboardHistory,
      { step: transition.step, action: transition.action, at: transition.at },
    ],
    navigationGraph: recordTransition(state.navigationGraph, {
      from: transition.from,
      to: transition.to,
      action: transition.action,
      url: state.url,
      step: transition.step,
      at: transition.at,
    }),
  };
}

/**
 * Seeds the graph with the state the agent starts in.
 *
 * Without it the first keypress would create an edge from a node nobody has
 * recorded, and the traversal would appear to begin at its second position.
 */
export function applyInitialNode(state: AgentState, step: StepIndex): AgentState {
  const { navigationGraph, currentFocus, url } = state;
  const id = nodeIdForFocus(currentFocus);

  if (navigationGraph.nodes.some((node) => node.id === id)) return state;

  return {
    ...state,
    navigationGraph: {
      nodes: [...navigationGraph.nodes, buildNode(currentFocus, { id, url, step })],
      edges: navigationGraph.edges,
    },
  };
}

function buildNode(
  focus: FocusState,
  context: {
    id: ReturnType<typeof nodeIdForFocus>;
    url: AgentState["url"];
    step: StepIndex;
  },
) {
  const element = focusedElement(focus);

  return {
    id: context.id,
    url: context.url,
    focusKind: focus.kind,
    elementId: element?.id ?? null,
    role: element?.role ?? null,
    accessibleName: element?.accessibleName ?? null,
    firstSeenAtStep: context.step,
    visitCount: 1,
  };
}

/** Appends a completed step. `currentStep` is the count of completed steps. */
export function appendStep(state: AgentState, step: AgentStep): AgentState {
  return {
    ...state,
    steps: [...state.steps, step],
    currentStep: state.steps.length + 1,
  };
}

/**
 * Records a hypothesis the agent wants to keep testing.
 *
 * Deduplicated by issue type: an agent that suspects the same problem on five
 * consecutive steps has one hypothesis, not five, and repeating it back in the
 * prompt would make it look like mounting evidence.
 */
export function addSuspectedFinding(
  state: AgentState,
  finding: SuspectedFinding,
): AgentState {
  const alreadyOpen = state.suspectedFindings.some(
    (existing) => existing.details.type === finding.details.type,
  );

  if (alreadyOpen) return state;

  return { ...state, suspectedFindings: [...state.suspectedFindings, finding] };
}

/** Sets the agent's status. Terminal statuses carry why. */
export function withStatus(state: AgentState, status: AgentState["status"]): AgentState {
  return { ...state, status };
}
