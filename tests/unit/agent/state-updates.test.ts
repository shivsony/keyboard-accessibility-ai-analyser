import { describe, expect, it } from "vitest";

import {
  addSuspectedFinding,
  appendStep,
  applyInitialNode,
  applyObservation,
  applyScreenshot,
  applyTransition,
  withStatus,
} from "@/lib/agent";
import {
  checkAgentStateInvariants,
  confidence,
  createInitialAgentState,
  findingId,
  focusOn,
  type SuspectedFinding,
} from "@/lib/shared/domain";

import {
  at,
  makeElement,
  makeObservation,
  makeScreenshot,
  makeStep,
  TEST_AUDIT_ID,
  TEST_URL,
} from "../../fixtures/domain";

/**
 * The agent's memory, transition by transition.
 *
 * Every case ends by checking the domain invariants: a transition that leaves
 * state incoherent produces findings that cannot be reproduced, which is the
 * failure this whole layer exists to prevent.
 */

const initial = () => createInitialAgentState({ auditId: TEST_AUDIT_ID, url: TEST_URL });

const LOGO = makeElement("logo", { accessibleName: "Logo", role: "link" });
const SEARCH = makeElement("search", { accessibleName: "Search" });

describe("applyObservation", () => {
  it("sets the current observation and focus", () => {
    const observation = makeObservation(0, { focus: focusOn(LOGO) });
    const state = applyObservation(initial(), observation);

    expect(state.currentObservation).toBe(observation);
    expect(state.currentFocus).toEqual(focusOn(LOGO));
  });

  it("moves the previous observation into history", () => {
    let state = applyObservation(initial(), makeObservation(0));
    state = applyObservation(state, makeObservation(1));

    expect(state.previousObservations.map((o) => o.step)).toEqual([0]);
    expect(state.currentObservation?.step).toBe(1);
  });

  it("merges newly discovered elements", () => {
    let state = applyObservation(
      initial(),
      makeObservation(0, { interactiveElements: [LOGO] }),
    );
    state = applyObservation(
      state,
      makeObservation(1, { interactiveElements: [LOGO, SEARCH] }),
    );

    expect(state.discoveredElements.map((element) => element.id)).toEqual([
      "logo",
      "search",
    ]);
  });

  // `discoveredAtStep` is what evidence paths are measured against. Overwriting
  // it each observation would make every element look newly appeared.
  it("keeps the first sighting of an element", () => {
    let state = applyObservation(
      initial(),
      makeObservation(0, { interactiveElements: [LOGO] }),
    );
    state = applyObservation(
      state,
      makeObservation(4, {
        interactiveElements: [makeElement("logo", { discoveredAtStep: 4 })],
      }),
    );

    expect(state.discoveredElements).toHaveLength(1);
    expect(state.discoveredElements[0]?.discoveredAtStep).toBe(0);
  });

  // An element focused but never discovered would violate the invariant that
  // visited is a subset of discovered.
  it("registers a focused element that discovery missed", () => {
    const state = applyObservation(
      initial(),
      makeObservation(0, { focus: focusOn(LOGO), interactiveElements: [] }),
    );

    expect(state.discoveredElements.map((element) => element.id)).toEqual(["logo"]);
    expect(state.visitedElementIds).toEqual(["logo"]);
    expect(checkAgentStateInvariants(state)).toEqual([]);
  });

  it("does not record the same visit twice", () => {
    let state = applyObservation(initial(), makeObservation(0, { focus: focusOn(LOGO) }));
    state = applyObservation(state, makeObservation(1, { focus: focusOn(LOGO) }));

    expect(state.visitedElementIds).toEqual(["logo"]);
  });

  it("records no visit when focus is not on an element", () => {
    const state = applyObservation(
      initial(),
      makeObservation(0, { focus: { kind: "OUTSIDE_PAGE" } }),
    );

    expect(state.visitedElementIds).toEqual([]);
    expect(state.currentFocus).toEqual({ kind: "OUTSIDE_PAGE" });
  });
});

describe("applyTransition", () => {
  it("records the keypress and the graph edge together", () => {
    let state = applyObservation(initial(), makeObservation(0, { focus: focusOn(LOGO) }));
    state = applyInitialNode(state, 0);
    state = applyObservation(state, makeObservation(1, { focus: focusOn(SEARCH) }));
    state = applyTransition(state, {
      from: focusOn(LOGO),
      to: focusOn(SEARCH),
      action: "TAB",
      step: 0,
      at: at(0),
    });

    expect(state.keyboardHistory).toEqual([{ step: 0, action: "TAB", at: at(0) }]);
    expect(state.navigationGraph.edges).toHaveLength(1);
    expect(state.navigationGraph.nodes).toHaveLength(2);
  });
});

describe("applyInitialNode", () => {
  // Without it the first keypress creates an edge from a node nobody recorded,
  // and the traversal appears to start at its second position.
  it("seeds the graph with the starting position", () => {
    let state = applyObservation(initial(), makeObservation(0, { focus: focusOn(LOGO) }));
    state = applyInitialNode(state, 0);

    expect(state.navigationGraph.nodes).toHaveLength(1);
    expect(state.navigationGraph.nodes[0]?.accessibleName).toBe("Logo");
  });

  it("is idempotent", () => {
    let state = applyObservation(initial(), makeObservation(0, { focus: focusOn(LOGO) }));
    state = applyInitialNode(state, 0);
    state = applyInitialNode(state, 0);

    expect(state.navigationGraph.nodes).toHaveLength(1);
  });
});

describe("appendStep", () => {
  it("advances the step counter with the record", () => {
    let state = applyObservation(initial(), makeObservation(0));
    state = appendStep(state, makeStep(0, null));

    expect(state.currentStep).toBe(1);
    expect(state.steps).toHaveLength(1);
  });
});

describe("applyScreenshot", () => {
  it("registers a screenshot once", () => {
    let state = applyScreenshot(initial(), makeScreenshot("shot-0", 0));
    state = applyScreenshot(state, makeScreenshot("shot-0", 0));

    expect(state.screenshots).toHaveLength(1);
  });
});

describe("addSuspectedFinding", () => {
  const suspicion = (type: SuspectedFinding["details"]["type"]): SuspectedFinding => ({
    id: findingId(`f-${type}`),
    status: "SUSPECTED",
    details:
      type === "SUSPICIOUS_FOCUS_ORDER"
        ? { type, observedOrder: [], expectedOrder: [] }
        : { type: "NO_KEYBOARD_REACHABLE_CONTROLS", discoveredCount: 1 },
    reasoning: "Looks wrong.",
    confidence: confidence(0.6),
    detectedAtStep: 0,
    detectedAt: at(0),
  });

  it("records a hypothesis", () => {
    const state = addSuspectedFinding(initial(), suspicion("SUSPICIOUS_FOCUS_ORDER"));

    expect(state.suspectedFindings).toHaveLength(1);
  });

  // Five consecutive suspicions of the same problem are one hypothesis, not
  // five. Repeating it back in the prompt would look like mounting evidence.
  it("does not raise the same hypothesis twice", () => {
    let state = addSuspectedFinding(initial(), suspicion("SUSPICIOUS_FOCUS_ORDER"));
    state = addSuspectedFinding(state, suspicion("SUSPICIOUS_FOCUS_ORDER"));

    expect(state.suspectedFindings).toHaveLength(1);
  });

  it("keeps distinct hypotheses apart", () => {
    let state = addSuspectedFinding(initial(), suspicion("SUSPICIOUS_FOCUS_ORDER"));
    state = addSuspectedFinding(state, suspicion("NO_KEYBOARD_REACHABLE_CONTROLS"));

    expect(state.suspectedFindings).toHaveLength(2);
  });
});

describe("withStatus", () => {
  it("carries the reason on a terminal status", () => {
    const state = withStatus(initial(), {
      kind: "STOPPED",
      reason: "STEP_BUDGET_EXHAUSTED",
    });

    expect(state.status).toEqual({
      kind: "STOPPED",
      reason: "STEP_BUDGET_EXHAUSTED",
    });
  });
});

describe("transitions preserve the invariants", () => {
  it("keeps a full step sequence coherent", () => {
    let state = initial();

    state = applyScreenshot(state, makeScreenshot("shot-0", 0));
    state = applyObservation(state, makeObservation(0, { focus: focusOn(LOGO) }));
    state = applyInitialNode(state, 0);

    state = applyScreenshot(state, makeScreenshot("shot-1", 1));
    state = applyObservation(state, makeObservation(1, { focus: focusOn(SEARCH) }));
    state = applyTransition(state, {
      from: focusOn(LOGO),
      to: focusOn(SEARCH),
      action: "TAB",
      step: 0,
      at: at(0),
    });
    state = appendStep(state, makeStep(0, "TAB"));

    expect(checkAgentStateInvariants(state)).toEqual([]);
  });
});
