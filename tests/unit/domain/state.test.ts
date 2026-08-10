import { describe, expect, it } from "vitest";

import {
  AgentStateSchema,
  allObservations,
  createInitialAgentState,
  isAgentFinished,
  keyboardSequence,
  unreachedElements,
  checkAgentStateInvariants,
  elementId,
} from "@/lib/shared/domain";
import {
  at,
  makeElement,
  makeObservation,
  makeState,
  TEST_AUDIT_ID,
  TEST_URL,
} from "../../fixtures/domain";

describe("createInitialAgentState", () => {
  it("starts empty, with focus unknown rather than assumed", () => {
    const state = createInitialAgentState({ auditId: TEST_AUDIT_ID, url: TEST_URL });

    expect(state.currentStep).toBe(0);
    expect(state.currentObservation).toBeNull();
    expect(state.currentFocus).toEqual({ kind: "UNKNOWN" });
    expect(state.status).toEqual({ kind: "IDLE" });
    expect(state.discoveredElements).toEqual([]);
    expect(state.keyboardHistory).toEqual([]);
    expect(state.steps).toEqual([]);
  });

  it("is coherent on its own", () => {
    const state = createInitialAgentState({ auditId: TEST_AUDIT_ID, url: TEST_URL });

    expect(checkAgentStateInvariants(state)).toEqual([]);
  });
});

describe("AgentStateSchema", () => {
  // State is written to a run directory and read back; a shape that survives
  // the trip is what makes a finding reviewable after the fact.
  it("round-trips a state through JSON", () => {
    const state = makeState();
    const parsed = AgentStateSchema.parse(JSON.parse(JSON.stringify(state)));

    expect(parsed).toEqual(state);
  });

  it("rejects a non-http url", () => {
    const result = AgentStateSchema.safeParse({
      ...makeState(),
      url: "file:///etc/passwd",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a negative step index", () => {
    expect(AgentStateSchema.safeParse({ ...makeState(), currentStep: -1 }).success).toBe(
      false,
    );
  });
});

describe("state helpers", () => {
  it("orders observations oldest first, current last", () => {
    const state = makeState({
      previousObservations: [makeObservation(0), makeObservation(1)],
      currentObservation: makeObservation(2),
    });

    expect(allObservations(state).map((o) => o.step)).toEqual([0, 1, 2]);
  });

  it("omits a current observation that does not exist yet", () => {
    const state = makeState({
      previousObservations: [makeObservation(0)],
      currentObservation: null,
    });

    expect(allObservations(state).map((o) => o.step)).toEqual([0]);
  });

  it("extracts the bare keypress sequence", () => {
    const state = makeState({
      keyboardHistory: [
        { step: 0, action: "TAB", at: at(0) },
        { step: 1, action: "TAB", at: at(1) },
        { step: 2, action: "SHIFT_TAB", at: at(2) },
      ],
    });

    expect(keyboardSequence(state)).toEqual(["TAB", "TAB", "SHIFT_TAB"]);
  });

  // This is the raw material for UNREACHABLE_ELEMENT.
  it("reports discovered elements the keyboard never reached", () => {
    const state = makeState({
      discoveredElements: [makeElement("a"), makeElement("b"), makeElement("c")],
      visitedElementIds: [elementId("a"), elementId("c")],
    });

    expect(unreachedElements(state).map((e) => e.id)).toEqual(["b"]);
  });

  it("reports nothing unreached when every control was visited", () => {
    const state = makeState({
      discoveredElements: [makeElement("a")],
      visitedElementIds: [elementId("a")],
    });

    expect(unreachedElements(state)).toEqual([]);
  });

  it("knows when the agent will take no further steps", () => {
    expect(isAgentFinished(makeState({ status: { kind: "RUNNING" } }))).toBe(false);
    expect(isAgentFinished(makeState({ status: { kind: "IDLE" } }))).toBe(false);
    expect(
      isAgentFinished(
        makeState({ status: { kind: "STOPPED", reason: "AGENT_STOPPED" } }),
      ),
    ).toBe(true);
    expect(
      isAgentFinished(
        makeState({
          status: { kind: "FAILED", error: { code: "BROWSER_ERROR", message: "gone" } },
        }),
      ),
    ).toBe(true);
  });

  // A stopped run that does not say why is how termination reasons go missing.
  it("carries the reason on a stopped status", () => {
    const state = makeState({
      status: { kind: "STOPPED", reason: "STEP_BUDGET_EXHAUSTED" },
    });

    if (state.status.kind === "STOPPED") {
      expect(state.status.reason).toBe("STEP_BUDGET_EXHAUSTED");
    } else {
      expect.unreachable("expected STOPPED");
    }
  });
});
