import { describe, expect, it } from "vitest";

import {
  abandonInvestigation,
  applyObservation,
  confirmInvestigation,
  investigationExhausted,
  openInvestigation,
  recordInvestigationAttempt,
  skippedElementIds,
} from "@/lib/agent";
import {
  activeInvestigation,
  agentMode,
  checkAgentStateInvariants,
  confidence,
  createInitialAgentState,
  elementId,
  focusOn,
  type AgentState,
  type SuspectedIssue,
} from "@/lib/shared/domain";

import {
  at,
  makeElement,
  makeObservation,
  TEST_AUDIT_ID,
  TEST_URL,
} from "../../fixtures/domain";

/**
 * The worked example, as state.
 *
 *   Discovered:  Menu, Search, Filter, Checkout
 *   Focus path:  Logo → Search → Checkout
 *
 * Menu and Filter were skipped. That is a suspicion, not a finding: the
 * traversal may simply not have got to them. Telling the two apart takes more
 * keypresses, which is what an investigation is.
 */

const LOGO = makeElement("logo", { accessibleName: "Logo", role: "link" });
const MENU = makeElement("menu", { accessibleName: "Menu", role: "button" });
const SEARCH = makeElement("search", { accessibleName: "Search" });
const FILTER = makeElement("filter", { accessibleName: "Filter", role: "button" });
const CHECKOUT = makeElement("checkout", { accessibleName: "Checkout" });

const SUSPICION: SuspectedIssue = {
  type: "UNREACHABLE_ELEMENT",
  severity: "HIGH",
};

/** State after Logo → Search → Checkout, with Menu and Filter never focused. */
function afterSkippedTraversal(): AgentState {
  let state = createInitialAgentState({ auditId: TEST_AUDIT_ID, url: TEST_URL });

  const all = [LOGO, MENU, SEARCH, FILTER, CHECKOUT];

  state = applyObservation(
    state,
    makeObservation(0, { focus: focusOn(LOGO), interactiveElements: all }),
  );
  state = applyObservation(
    state,
    makeObservation(1, { focus: focusOn(SEARCH), interactiveElements: all }),
  );
  state = applyObservation(
    state,
    makeObservation(2, { focus: focusOn(CHECKOUT), interactiveElements: all }),
  );

  return state;
}

describe("noticing a suspicious focus transition", () => {
  it("identifies the controls the traversal skipped", () => {
    const state = afterSkippedTraversal();

    expect(state.visitedElementIds).toEqual(["logo", "search", "checkout"]);
    expect(skippedElementIds(state)).toEqual(["menu", "filter"]);
  });

  it("reports nothing skipped once everything has been reached", () => {
    let state = afterSkippedTraversal();
    state = applyObservation(state, makeObservation(3, { focus: focusOn(MENU) }));
    state = applyObservation(state, makeObservation(4, { focus: focusOn(FILTER) }));

    expect(skippedElementIds(state)).toEqual([]);
  });
});

describe("opening an investigation", () => {
  const open = (state = afterSkippedTraversal()) =>
    openInvestigation(state, {
      issue: SUSPICION,
      step: 3,
      hypothesis: "Focus went from Search to Checkout; Menu and Filter were skipped.",
      confidence: confidence(0.6),
      at: at(3),
    });

  it("switches the agent from exploring to investigating", () => {
    expect(agentMode(afterSkippedTraversal())).toBe("EXPLORING");
    expect(agentMode(open())).toBe("INVESTIGATING");
  });

  // Captured at open time, so the record shows what looked wrong *then* — not
  // what the traversal happened to still be missing when it concluded.
  it("captures the suspicious controls", () => {
    const investigation = activeInvestigation(open());

    expect(investigation?.suspiciousElementIds).toEqual(["menu", "filter"]);
    expect(investigation?.issueType).toBe("UNREACHABLE_ELEMENT");
    expect(investigation?.severity).toBe("HIGH");
  });

  it("records the observation that triggered it", () => {
    const investigation = activeInvestigation(open());

    expect(investigation?.triggeringStep).toBe(3);
    expect(investigation?.triggeringFocus).toEqual(focusOn(CHECKOUT));
  });

  it("records the first hypothesis with its confidence", () => {
    const investigation = activeInvestigation(open());

    expect(investigation?.hypotheses).toHaveLength(1);
    expect(investigation?.hypotheses[0]?.statement).toContain("Menu and Filter");
    expect(investigation?.confidence).toBe(0.6);
  });

  it("puts a control the model named at the front of the suspicion", () => {
    const state = openInvestigation(afterSkippedTraversal(), {
      issue: SUSPICION,
      step: 3,
      hypothesis: "Filter looks unreachable.",
      confidence: confidence(0.6),
      at: at(3),
      targetElementId: elementId("filter"),
    });

    expect(activeInvestigation(state)?.suspiciousElementIds).toEqual(["filter", "menu"]);
  });

  it("starts with no evidence beyond where it began", () => {
    const investigation = activeInvestigation(open());

    expect(investigation?.evidenceActions).toEqual([]);
    expect(investigation?.attemptedActions).toEqual([]);
    expect(investigation?.evidenceFocusSequence).toEqual([focusOn(CHECKOUT)]);
  });

  it("leaves the state coherent", () => {
    expect(checkAgentStateInvariants(open())).toEqual([]);
  });
});

describe("accumulating evidence", () => {
  function investigating(): AgentState {
    return openInvestigation(afterSkippedTraversal(), {
      issue: SUSPICION,
      step: 3,
      hypothesis: "Menu and Filter were skipped.",
      confidence: confidence(0.6),
      at: at(3),
    });
  }

  it("records each keypress, where it landed, and the current confidence", () => {
    let state = investigating();

    state = recordInvestigationAttempt(state, {
      action: "SHIFT_TAB",
      step: 4,
      resultingFocus: focusOn(SEARCH),
      hypothesis: "Going back: does Shift+Tab reach Filter?",
      confidence: confidence(0.75),
      at: at(4),
    });

    const investigation = activeInvestigation(state);

    expect(investigation?.evidenceActions).toEqual(["SHIFT_TAB"]);
    expect(investigation?.evidenceFocusSequence).toHaveLength(2);
    expect(investigation?.attemptedActions).toEqual([
      { step: 4, action: "SHIFT_TAB", at: at(4) },
    ]);
    expect(investigation?.confidence).toBe(0.75);
  });

  it("builds the evidence path in order across several keypresses", () => {
    let state = investigating();

    for (const [index, action] of (
      ["SHIFT_TAB", "SHIFT_TAB", "TAB"] as const
    ).entries()) {
      state = recordInvestigationAttempt(state, {
        action,
        step: 4 + index,
        resultingFocus: focusOn(SEARCH),
        hypothesis: `Attempt ${index}`,
        confidence: confidence(0.8),
        at: at(4 + index),
      });
    }

    expect(activeInvestigation(state)?.evidenceActions).toEqual([
      "SHIFT_TAB",
      "SHIFT_TAB",
      "TAB",
    ]);
  });

  // Evidence can weaken a suspicion as easily as strengthen it. An agent that
  // grows more certain with every keypress is committing, not investigating.
  it("lets confidence fall as well as rise", () => {
    let state = investigating();

    state = recordInvestigationAttempt(state, {
      action: "SHIFT_TAB",
      step: 4,
      resultingFocus: focusOn(FILTER),
      hypothesis: "Shift+Tab does reach Filter after all.",
      confidence: confidence(0.2),
      at: at(4),
    });

    expect(activeInvestigation(state)?.confidence).toBe(0.2);
  });

  it("records a new hypothesis but not a restated one", () => {
    let state = investigating();

    state = recordInvestigationAttempt(state, {
      action: "SHIFT_TAB",
      step: 4,
      resultingFocus: focusOn(SEARCH),
      hypothesis: "Menu and Filter were skipped.", // the same as the first
      confidence: confidence(0.7),
      at: at(4),
    });
    expect(activeInvestigation(state)?.hypotheses).toHaveLength(1);

    state = recordInvestigationAttempt(state, {
      action: "SHIFT_TAB",
      step: 5,
      resultingFocus: focusOn(LOGO),
      hypothesis: "They may be div elements with no tabindex.",
      confidence: confidence(0.85),
      at: at(5),
    });
    expect(activeInvestigation(state)?.hypotheses).toHaveLength(2);
  });

  it("does nothing when no investigation is open", () => {
    const state = afterSkippedTraversal();

    const unchanged = recordInvestigationAttempt(state, {
      action: "TAB",
      step: 3,
      resultingFocus: focusOn(LOGO),
      hypothesis: "Nothing to attach this to.",
      confidence: confidence(0.5),
      at: at(3),
    });

    expect(unchanged.investigations).toEqual([]);
  });

  it("stays coherent as evidence accumulates", () => {
    let state = investigating();
    state = recordInvestigationAttempt(state, {
      action: "SHIFT_TAB",
      step: 4,
      resultingFocus: focusOn(SEARCH),
      hypothesis: "Checking backwards.",
      confidence: confidence(0.7),
      at: at(4),
    });

    expect(checkAgentStateInvariants(state)).toEqual([]);
  });
});

describe("reporting after investigation", () => {
  it("closes the investigation as confirmed", () => {
    let state = openInvestigation(afterSkippedTraversal(), {
      issue: SUSPICION,
      step: 3,
      hypothesis: "Menu and Filter were skipped.",
      confidence: confidence(0.6),
      at: at(3),
    });
    state = recordInvestigationAttempt(state, {
      action: "SHIFT_TAB",
      step: 4,
      resultingFocus: focusOn(SEARCH),
      hypothesis: "Backwards does not reach them either.",
      confidence: confidence(0.9),
      at: at(4),
    });

    state = confirmInvestigation(state, { at: at(5), confidence: confidence(0.95) });

    const investigation = state.investigations[0];

    expect(investigation?.status).toBe("CONFIRMED");
    expect(investigation?.confidence).toBe(0.95);
    expect(investigation?.closedAt).toBe(at(5));
    expect(investigation?.abandonReason).toBeNull();
    expect(agentMode(state)).toBe("EXPLORING");
  });

  // The evidence outlives the investigation; that is the point of gathering it.
  it("keeps the evidence path after closing", () => {
    let state = openInvestigation(afterSkippedTraversal(), {
      issue: SUSPICION,
      step: 3,
      hypothesis: "Skipped.",
      confidence: confidence(0.6),
      at: at(3),
    });
    state = recordInvestigationAttempt(state, {
      action: "SHIFT_TAB",
      step: 4,
      resultingFocus: focusOn(SEARCH),
      hypothesis: "Backwards.",
      confidence: confidence(0.9),
      at: at(4),
    });
    state = confirmInvestigation(state, { at: at(5) });

    expect(state.investigations[0]?.evidenceActions).toEqual(["SHIFT_TAB"]);
    expect(state.investigations[0]?.suspiciousElementIds).toEqual(["menu", "filter"]);
  });
});

describe("abandoning a false suspicion", () => {
  const investigating = () =>
    openInvestigation(afterSkippedTraversal(), {
      issue: SUSPICION,
      step: 3,
      hypothesis: "Menu and Filter were skipped.",
      confidence: confidence(0.6),
      at: at(3),
    });

  it("closes the line of enquiry without a finding", () => {
    const state = abandonInvestigation(investigating(), {
      at: at(6),
      reason: "AGENT_MOVED_ON",
    });

    expect(state.investigations[0]?.status).toBe("ABANDONED");
    expect(state.investigations[0]?.abandonReason).toBe("AGENT_MOVED_ON");
    expect(agentMode(state)).toBe("EXPLORING");
  });

  // "The agent looked into this and concluded nothing" is a result, and one
  // worth showing to somebody deciding how much to trust the rest of the run.
  it("keeps the abandoned investigation on the record", () => {
    let state = investigating();
    state = recordInvestigationAttempt(state, {
      action: "SHIFT_TAB",
      step: 4,
      resultingFocus: focusOn(FILTER),
      hypothesis: "Filter is reachable backwards; the suspicion was wrong.",
      confidence: confidence(0.1),
      at: at(4),
    });
    state = abandonInvestigation(state, { at: at(5), reason: "AGENT_MOVED_ON" });

    expect(state.investigations).toHaveLength(1);
    expect(state.investigations[0]?.hypotheses).toHaveLength(2);
    expect(state.investigations[0]?.confidence).toBe(0.1);
  });

  it("allows a fresh investigation afterwards", () => {
    let state = abandonInvestigation(investigating(), {
      at: at(5),
      reason: "AGENT_MOVED_ON",
    });

    state = openInvestigation(state, {
      issue: { type: "SUSPICIOUS_FOCUS_ORDER", severity: "MEDIUM" },
      step: 6,
      hypothesis: "Something else looks wrong now.",
      confidence: confidence(0.5),
      at: at(6),
    });

    expect(state.investigations).toHaveLength(2);
    expect(activeInvestigation(state)?.issueType).toBe("SUSPICIOUS_FOCUS_ORDER");
    expect(checkAgentStateInvariants(state)).toEqual([]);
  });

  // A line of enquiry must not quietly consume the whole run.
  it("knows when an investigation has outstayed its budget", () => {
    let state = investigating();

    expect(investigationExhausted(state, 3)).toBe(false);

    for (let index = 0; index < 3; index += 1) {
      state = recordInvestigationAttempt(state, {
        action: "TAB",
        step: 4 + index,
        resultingFocus: focusOn(LOGO),
        hypothesis: `Attempt ${index}`,
        confidence: confidence(0.5),
        at: at(4 + index),
      });
    }

    expect(investigationExhausted(state, 3)).toBe(true);
  });

  it("reports no exhaustion when nothing is being investigated", () => {
    expect(investigationExhausted(afterSkippedTraversal(), 1)).toBe(false);
  });
});

describe("invariants", () => {
  // Two questions at once means neither has a clean evidence path.
  it("rejects two open investigations", () => {
    let state = openInvestigation(afterSkippedTraversal(), {
      issue: SUSPICION,
      step: 3,
      hypothesis: "First.",
      confidence: confidence(0.5),
      at: at(3),
    });

    // Forced past the transitions, which would never produce this.
    state = {
      ...state,
      investigations: [
        ...state.investigations,
        { ...state.investigations[0]!, id: "inv-second" as never },
      ],
    };

    expect(checkAgentStateInvariants(state).map((v) => v.code)).toContain(
      "MULTIPLE_OPEN_INVESTIGATIONS",
    );
  });

  it("rejects a suspicion about an element discovery never saw", () => {
    const state = openInvestigation(afterSkippedTraversal(), {
      issue: SUSPICION,
      step: 3,
      hypothesis: "Ghost.",
      confidence: confidence(0.5),
      at: at(3),
      targetElementId: elementId("never-discovered"),
    });

    expect(checkAgentStateInvariants(state).map((v) => v.code)).toContain(
      "INVESTIGATION_ELEMENT_NOT_DISCOVERED",
    );
  });

  it("rejects a closed investigation with no outcome recorded", () => {
    let state = openInvestigation(afterSkippedTraversal(), {
      issue: SUSPICION,
      step: 3,
      hypothesis: "First.",
      confidence: confidence(0.5),
      at: at(3),
    });

    state = {
      ...state,
      investigations: [{ ...state.investigations[0]!, status: "ABANDONED" }],
    };

    expect(checkAgentStateInvariants(state).map((v) => v.code)).toContain(
      "CLOSED_INVESTIGATION_WITHOUT_OUTCOME",
    );
  });
});
