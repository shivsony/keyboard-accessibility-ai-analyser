import { describe, expect, it } from "vitest";

import { applyObservation, applyTransition, appendStep } from "@/lib/agent";
import { FindingValidator, observeFindings, type FindingClaim } from "@/lib/rules";
import {
  createInitialAgentState,
  elementId,
  focusOn,
  type AgentState,
  type ReportedIssue,
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
 * The validator's job is to reject.
 *
 * Most of these tests hand it a claim that a careless — or confidently wrong —
 * model might make, and check that the claim does not survive contact with the
 * recorded traversal. A report that misstates what happened is worse than no
 * report: somebody follows the steps, sees something else, and stops trusting
 * the rest of it.
 */

const LOGO = makeElement("logo", { accessibleName: "Logo", role: "link" });
const MENU = makeElement("menu", { accessibleName: "Menu", role: "button" });
const SEARCH = makeElement("search", { accessibleName: "Search" });
const CHECKOUT = makeElement("checkout", { accessibleName: "Checkout" });

const ALL = [LOGO, MENU, SEARCH, CHECKOUT];

const UNREACHABLE: ReportedIssue = {
  type: "UNREACHABLE_ELEMENT",
  severity: "HIGH",
  title: "Menu cannot be reached by keyboard",
  description: "Menu is a div with role=button and no tabindex.",
};

/**
 * A run that reached Logo → Search → Checkout and never focused Menu.
 *
 * The honest version of the worked example: two keypresses recorded, screenshots
 * captured, one control genuinely skipped.
 */
function traceWithSkippedMenu(): AgentState {
  let state = createInitialAgentState({ auditId: TEST_AUDIT_ID, url: TEST_URL });

  state = {
    ...state,
    screenshots: [makeScreenshot("shot-0", 0), makeScreenshot("shot-1", 1)],
  };

  state = applyObservation(
    state,
    makeObservation(0, { focus: focusOn(LOGO), interactiveElements: ALL }),
  );
  state = applyObservation(
    state,
    makeObservation(1, { focus: focusOn(SEARCH), interactiveElements: ALL }),
  );
  state = applyTransition(state, {
    from: focusOn(LOGO),
    to: focusOn(SEARCH),
    action: "TAB",
    step: 0,
    at: at(0),
  });
  state = appendStep(state, makeStep(0, "TAB"));

  state = applyObservation(
    state,
    makeObservation(2, { focus: focusOn(CHECKOUT), interactiveElements: ALL }),
  );
  state = applyTransition(state, {
    from: focusOn(SEARCH),
    to: focusOn(CHECKOUT),
    action: "TAB",
    step: 1,
    at: at(1),
  });
  state = appendStep(state, makeStep(1, "TAB"));

  return state;
}

function claim(overrides: Partial<FindingClaim> = {}): FindingClaim {
  return {
    issue: UNREACHABLE,
    reason: "Two full traversals never focused Menu.",
    confidence: 0.9,
    step: 2,
    targetElementId: elementId("menu"),
    ...overrides,
  };
}

function validate(state: AgentState, overrides: Partial<FindingClaim> = {}) {
  return new FindingValidator(state).validate(claim(overrides));
}

/** The rejection reasons, for terser assertions. */
function reasons(result: ReturnType<typeof validate>): string[] {
  return result.outcome === "REJECTED"
    ? result.problems.map((problem) => problem.reason)
    : [];
}

describe("observations — what the trace shows", () => {
  it("observes the control the traversal never reached", () => {
    const observed = observeFindings(traceWithSkippedMenu());

    expect(
      observed.filter((finding) => finding.details.type === "UNREACHABLE_ELEMENT"),
    ).toHaveLength(1);
  });

  // Observations are facts, not judgements. They carry no reasoning and no
  // confidence, because those are the model's contribution.
  it("carries no interpretation", () => {
    const observed = observeFindings(traceWithSkippedMenu())[0];

    expect(observed?.status).toBe("OBSERVED");
    expect(observed).not.toHaveProperty("reasoning");
    expect(observed).not.toHaveProperty("confidence");
    expect(observed).not.toHaveProperty("severity");
  });

  it("observes nothing unreachable once every control has been reached", () => {
    let state = traceWithSkippedMenu();
    state = applyObservation(state, makeObservation(3, { focus: focusOn(MENU) }));

    expect(
      observeFindings(state).filter(
        (finding) => finding.details.type === "UNREACHABLE_ELEMENT",
      ),
    ).toEqual([]);
  });
});

describe("a well-supported finding", () => {
  it("is confirmed", () => {
    const result = validate(traceWithSkippedMenu());

    expect(result.outcome).toBe("CONFIRMED");
  });

  // The model contributes interpretation. Every fact comes from the recording.
  it("builds its evidence from the trace, not the claim", () => {
    const result = validate(traceWithSkippedMenu());

    if (result.outcome !== "CONFIRMED") return expect.unreachable("expected CONFIRMED");

    expect(result.finding.evidence.keyboardSequence).toEqual(["TAB", "TAB"]);
    expect(result.finding.evidence.screenshotIds).toEqual(["shot-0", "shot-1"]);
    expect(result.finding.evidence.focusSequence).toHaveLength(2);
    expect(result.finding.severity).toBe("HIGH");
    expect(result.finding.reasoning).toContain("never focused Menu");
  });

  it("takes the element from the observation, not the claim", () => {
    const result = validate(traceWithSkippedMenu(), { targetElementId: null });

    if (result.outcome !== "CONFIRMED") return expect.unreachable("expected CONFIRMED");
    if (result.finding.details.type !== "UNREACHABLE_ELEMENT") {
      return expect.unreachable("expected an unreachable-element finding");
    }

    expect(result.finding.details.elementId).toBe("menu");
  });

  it("accepts a claimed sequence that matches the trace", () => {
    const result = validate(traceWithSkippedMenu(), {
      claimedKeyboardSequence: ["TAB", "TAB"],
    });

    expect(result.outcome).toBe("CONFIRMED");
  });

  it("accepts a claimed focus path the trace supports", () => {
    const result = validate(traceWithSkippedMenu(), {
      claimedFocusElementIds: [elementId("logo"), elementId("search")],
    });

    expect(result.outcome).toBe("CONFIRMED");
  });
});

describe("the AI reports a sequence that does not exist", () => {
  it("rejects a sequence the run never pressed", () => {
    const result = validate(traceWithSkippedMenu(), {
      claimedKeyboardSequence: ["SHIFT_TAB", "SHIFT_TAB", "TAB"],
    });

    expect(reasons(result)).toContain("SEQUENCE_NOT_IN_TRACE");
  });

  // Evidence runs from step 0. A sequence starting mid-run cannot be replayed
  // from a cold browser, which is the whole point of recording it.
  it("rejects a sequence that is not a prefix of the run", () => {
    const result = validate(traceWithSkippedMenu(), {
      claimedKeyboardSequence: ["SHIFT_TAB"],
    });

    expect(reasons(result)).toContain("SEQUENCE_NOT_IN_TRACE");
  });

  it("rejects a sequence longer than the run", () => {
    const result = validate(traceWithSkippedMenu(), {
      claimedKeyboardSequence: ["TAB", "TAB", "TAB", "TAB"],
    });

    expect(reasons(result)).toContain("SEQUENCE_NOT_IN_TRACE");
  });

  it("rejects any finding from a run that pressed nothing", () => {
    let state = createInitialAgentState({ auditId: TEST_AUDIT_ID, url: TEST_URL });
    state = { ...state, screenshots: [makeScreenshot("shot-0", 0)] };
    state = applyObservation(
      state,
      makeObservation(0, { focus: focusOn(LOGO), interactiveElements: ALL }),
    );

    expect(reasons(validate(state))).toContain("NO_KEYBOARD_SEQUENCE");
  });
});

describe("the AI claims focus that never happened", () => {
  // The claim this whole layer exists to catch: an element the model says was
  // focused, which the browser trace does not contain.
  it("rejects a claim that focus reached an undiscovered element", () => {
    const result = validate(traceWithSkippedMenu(), {
      claimedFocusElementIds: [elementId("phantom-button")],
    });

    expect(reasons(result)).toContain("ELEMENT_NOT_DISCOVERED");
  });

  it("rejects a claim that focus reached a discovered but unvisited element", () => {
    const result = validate(traceWithSkippedMenu(), {
      claimedFocusElementIds: [elementId("menu")],
    });

    expect(reasons(result)).toContain("ELEMENT_NOT_FOCUSED");
  });

  it("reports each bad claim separately", () => {
    const result = validate(traceWithSkippedMenu(), {
      claimedFocusElementIds: [elementId("menu"), elementId("phantom")],
    });

    expect(reasons(result)).toEqual(
      expect.arrayContaining(["ELEMENT_NOT_FOCUSED", "ELEMENT_NOT_DISCOVERED"]),
    );
  });

  it("rejects a finding about an element discovery never saw", () => {
    const result = validate(traceWithSkippedMenu(), {
      targetElementId: elementId("invented-control"),
    });

    expect(reasons(result)).toContain("ELEMENT_NOT_DISCOVERED");
  });

  // The specific contradiction this finding type invites.
  it("rejects an unreachable claim about an element the trace focused", () => {
    const result = validate(traceWithSkippedMenu(), {
      targetElementId: elementId("search"),
    });

    expect(reasons(result)).toContain("ELEMENT_WAS_REACHED");
  });
});

describe("corroboration", () => {
  // The architecture rule, as a test: the model's word alone confirms nothing.
  it("rejects a claim the trace shows no sign of", () => {
    const result = validate(traceWithSkippedMenu(), {
      issue: {
        type: "UNEXPECTED_FOCUS_LEAVING_PAGE",
        severity: "HIGH",
        title: "Focus escaped to the browser toolbar",
        description: "Tab moved focus out of the document.",
      },
      targetElementId: null,
    });

    expect(reasons(result)).toContain("NO_CORROBORATING_OBSERVATION");
  });

  it("rejects a focus-cycle claim on a traversal with no cycle", () => {
    const result = validate(traceWithSkippedMenu(), {
      issue: {
        type: "SUSPICIOUS_FOCUS_CYCLE",
        severity: "CRITICAL",
        title: "Focus is trapped",
        description: "Tab cycles between two controls forever.",
      },
      targetElementId: null,
    });

    expect(reasons(result)).toContain("NO_CORROBORATING_OBSERVATION");
  });

  it("rejects a no-reachable-controls claim when controls were reached", () => {
    const result = validate(traceWithSkippedMenu(), {
      issue: {
        type: "NO_KEYBOARD_REACHABLE_CONTROLS",
        severity: "CRITICAL",
        title: "Nothing is reachable",
        description: "The keyboard reaches no control on this page.",
      },
      targetElementId: null,
    });

    expect(reasons(result)).toContain("NO_CORROBORATING_OBSERVATION");
  });
});

describe("the remaining checks", () => {
  it("rejects an unsupported issue type", () => {
    const result = validate(traceWithSkippedMenu(), {
      issue: { ...UNREACHABLE, type: "COLOR_CONTRAST" as never },
    });

    expect(reasons(result)).toContain("UNSUPPORTED_ISSUE_TYPE");
  });

  it.each([-0.1, 1.5, Number.NaN])("rejects confidence %s", (confidence) => {
    expect(reasons(validate(traceWithSkippedMenu(), { confidence }))).toContain(
      "CONFIDENCE_OUT_OF_RANGE",
    );
  });

  it("accepts the boundaries", () => {
    expect(validate(traceWithSkippedMenu(), { confidence: 0 }).outcome).toBe("CONFIRMED");
    expect(validate(traceWithSkippedMenu(), { confidence: 1 }).outcome).toBe("CONFIRMED");
  });

  // A finding nobody can look at is not reproducible.
  it("rejects a finding with no screenshot behind it", () => {
    const state = { ...traceWithSkippedMenu(), screenshots: [] };

    expect(reasons(validate(state))).toContain("NO_SCREENSHOT_EVIDENCE");
  });
});

describe("reporting the problems", () => {
  // Three problems is a different situation from one near-miss, and telling
  // them apart matters when deciding whether the model is confused.
  it("reports every problem, not just the first", () => {
    const state = { ...traceWithSkippedMenu(), screenshots: [] };

    const result = validate(state, {
      confidence: 5,
      targetElementId: elementId("phantom"),
      claimedKeyboardSequence: ["SHIFT_TAB"],
    });

    expect(reasons(result)).toEqual(
      expect.arrayContaining([
        "CONFIDENCE_OUT_OF_RANGE",
        "ELEMENT_NOT_DISCOVERED",
        "SEQUENCE_NOT_IN_TRACE",
        "NO_SCREENSHOT_EVIDENCE",
      ]),
    );
  });

  it("explains each rejection in words a human can act on", () => {
    const result = validate(traceWithSkippedMenu(), {
      targetElementId: elementId("phantom"),
    });

    if (result.outcome !== "REJECTED") return expect.unreachable("expected REJECTED");

    for (const problem of result.problems) {
      expect(problem.detail.length).toBeGreaterThan(10);
    }
  });

  it("produces no finding at all when it rejects", () => {
    const result = validate(traceWithSkippedMenu(), {
      targetElementId: elementId("phantom"),
    });

    expect(result).not.toHaveProperty("finding");
  });
});
