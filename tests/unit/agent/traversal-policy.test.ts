import { describe, expect, it } from "vitest";

import { applyObservation, applyTransition, appendStep } from "@/lib/agent";
import { decideNextMove, type PolicyOptions } from "@/lib/agent/traversal-policy";
import {
  createInitialAgentState,
  focusOn,
  type AgentState,
  type FindingType,
} from "@/lib/shared/domain";

import {
  at,
  makeElement,
  makeObservation,
  makeStep,
  TEST_AUDIT_ID,
  TEST_URL,
} from "../../fixtures/domain";

/**
 * The traversal policy decides what happens next without a model.
 *
 * These tests are the budget. Every `SWEEP` is a step that costs nothing; every
 * `ESCALATE` is an API call. A change that turns sweeps into escalations is a
 * change to what an audit costs, and it should have to argue for itself here.
 */

const LOGO = makeElement("logo", { accessibleName: "Logo" });
const SEARCH = makeElement("search", { accessibleName: "Search" });
const MISSED = makeElement("missed", { accessibleName: "Missed", role: "button" });

function options(overrides: Partial<PolicyOptions> = {}): PolicyOptions {
  return {
    adjudicated: new Set<FindingType>(),
    repeats: 0,
    repeatedStateThreshold: 5,
    ...overrides,
  };
}

const initial = () => createInitialAgentState({ auditId: TEST_AUDIT_ID, url: TEST_URL });

/**
 * Records focus leaving the document, transition and all.
 *
 * The graph is what tells the policy a lap has been completed, and only
 * `applyTransition` puts a node in it — an observation alone leaves the policy
 * correctly believing the sweep is unfinished.
 */
function tabbedOffTheEnd(
  state: AgentState,
  elements: readonly ReturnType<typeof makeElement>[],
): AgentState {
  const step = state.steps.length;

  let next = applyObservation(
    state,
    makeObservation(step + 1, {
      focus: { kind: "OUTSIDE_PAGE" },
      interactiveElements: [...elements],
    }),
  );
  next = applyTransition(next, {
    from: state.currentFocus,
    to: { kind: "OUTSIDE_PAGE" },
    action: "TAB",
    step,
    at: at(step),
  });

  return appendStep(next, makeStep(step, "TAB"));
}

/** A traversal that reached everything and tabbed off the end of the page. */
function completeTraversal(): AgentState {
  let state = initial();
  const all = [LOGO, SEARCH];

  state = applyObservation(
    state,
    makeObservation(0, { focus: focusOn(LOGO), interactiveElements: all }),
  );
  state = applyObservation(
    state,
    makeObservation(1, { focus: focusOn(SEARCH), interactiveElements: all }),
  );
  state = applyTransition(state, {
    from: focusOn(LOGO),
    to: focusOn(SEARCH),
    action: "TAB",
    step: 0,
    at: at(0),
  });
  state = appendStep(state, makeStep(0, "TAB"));

  // Off the end of the tab order, which is how a complete sweep ends.
  state = applyObservation(
    state,
    makeObservation(2, { focus: { kind: "OUTSIDE_PAGE" }, interactiveElements: all }),
  );
  state = applyTransition(state, {
    from: focusOn(SEARCH),
    to: { kind: "OUTSIDE_PAGE" },
    action: "TAB",
    step: 1,
    at: at(1),
  });
  state = appendStep(state, makeStep(1, "TAB"));

  return state;
}

describe("sweeping", () => {
  it("presses Tab before anything has been observed", () => {
    expect(decideNextMove(initial(), options())).toMatchObject({
      kind: "SWEEP",
      action: "TAB",
    });
  });

  // The common case, and the whole point: an ordinary step costs nothing.
  it("keeps sweeping while there is more to reach", () => {
    let state = initial();
    state = applyObservation(
      state,
      makeObservation(0, {
        focus: focusOn(LOGO),
        interactiveElements: [LOGO, SEARCH],
      }),
    );

    expect(decideNextMove(state, options()).kind).toBe("SWEEP");
  });
});

describe("escalating", () => {
  // A control the traversal never reached is exactly what the model is for.
  it("asks the model when the trace supports a finding", () => {
    let state = initial();
    state = applyObservation(
      state,
      makeObservation(0, {
        focus: focusOn(LOGO),
        interactiveElements: [LOGO, MISSED],
      }),
    );
    state = tabbedOffTheEnd(state, [LOGO, MISSED]);

    expect(decideNextMove(state, options())).toMatchObject({
      kind: "ESCALATE",
      decisionPoint: "CANDIDATE_FINDING",
      issueType: "UNREACHABLE_ELEMENT",
    });
  });

  // The bug this policy exists to kill: a real run spent six consecutive calls
  // reporting the same thing, because nothing remembered it had already asked.
  it("does not ask the same question twice", () => {
    let state = initial();
    state = applyObservation(
      state,
      makeObservation(0, {
        focus: focusOn(LOGO),
        interactiveElements: [LOGO, MISSED],
      }),
    );
    state = tabbedOffTheEnd(state, [LOGO, MISSED]);

    const adjudicated = new Set<FindingType>(["UNREACHABLE_ELEMENT"]);

    expect(decideNextMove(state, options({ adjudicated })).kind).not.toBe("ESCALATE");
  });
});

describe("completing", () => {
  // Nothing left to reach and nothing looked wrong: there is no judgement to
  // buy, so the run ends without a call.
  it("ends without a model call when the traversal is done", () => {
    expect(decideNextMove(completeTraversal(), options())).toEqual({
      kind: "COMPLETE",
      reason: "AGENT_STOPPED",
    });
  });

  it("ends when the sweep is going in circles", () => {
    let state = initial();
    state = applyObservation(
      state,
      makeObservation(0, { focus: focusOn(LOGO), interactiveElements: [LOGO] }),
    );

    expect(
      decideNextMove(state, options({ repeats: 5, repeatedStateThreshold: 5 })),
    ).toEqual({ kind: "COMPLETE", reason: "REPEATED_STATE" });
  });

  // Order matters: a candidate finding is worth a call even when the sweep has
  // otherwise stalled. Stopping first would lose the finding.
  it("judges a candidate before giving up on a stuck sweep", () => {
    let state = initial();
    state = applyObservation(
      state,
      makeObservation(0, {
        focus: focusOn(LOGO),
        interactiveElements: [LOGO, MISSED],
      }),
    );
    state = tabbedOffTheEnd(state, [LOGO, MISSED]);

    expect(
      decideNextMove(state, options({ repeats: 99, repeatedStateThreshold: 5 })).kind,
    ).toBe("ESCALATE");
  });

  // A disabled control is correctly unreachable. Treating it as unfinished
  // business would keep the sweep running forever on a page that is fine.
  it("does not count correctly-unfocusable controls as unfinished", () => {
    let state = completeTraversal();
    const disabled = makeElement("off", { accessibleName: "Off", disabled: true });

    state = applyObservation(
      state,
      makeObservation(3, {
        focus: { kind: "OUTSIDE_PAGE" },
        interactiveElements: [LOGO, SEARCH, disabled],
      }),
    );

    expect(decideNextMove(state, options()).kind).toBe("COMPLETE");
  });
});
