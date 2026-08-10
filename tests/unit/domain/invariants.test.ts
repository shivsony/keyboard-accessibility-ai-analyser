import { describe, expect, it } from "vitest";

import {
  AgentStateInvariantError,
  assertAgentStateInvariants,
  checkAgentStateInvariants,
  elementId,
  findingId,
  nodeId,
  screenshotId,
  focusOn,
  type InvariantCode,
} from "@/lib/shared/domain";
import {
  at,
  makeConfirmedFinding,
  makeElement,
  makeEvidence,
  makeObservation,
  makeState,
  makeStep,
  TEST_URL,
} from "../../fixtures/domain";

function codes(...args: Parameters<typeof checkAgentStateInvariants>): InvariantCode[] {
  return checkAgentStateInvariants(...args).map((violation) => violation.code);
}

describe("AgentState invariants", () => {
  it("accepts a coherent state", () => {
    expect(checkAgentStateInvariants(makeState())).toEqual([]);
    expect(() => assertAgentStateInvariants(makeState())).not.toThrow();
  });

  describe("steps", () => {
    it("requires currentStep to match the number of recorded steps", () => {
      expect(codes(makeState({ currentStep: 5 }))).toContain("STEP_COUNT_MISMATCH");
    });

    it("requires step indices to be contiguous from zero", () => {
      const state = makeState({
        currentStep: 2,
        steps: [makeStep(0), makeStep(7)],
        keyboardHistory: [
          { step: 0, action: "TAB", at: at(0) },
          { step: 7, action: "TAB", at: at(7) },
        ],
      });

      expect(codes(state)).toContain("STEP_INDICES_NOT_CONTIGUOUS");
    });
  });

  describe("observations", () => {
    it("requires observation steps to ascend", () => {
      const state = makeState({
        previousObservations: [makeObservation(3), makeObservation(1)],
      });

      expect(codes(state)).toContain("OBSERVATION_STEPS_NOT_ASCENDING");
    });

    it("requires the current observation to come after the previous ones", () => {
      const state = makeState({
        previousObservations: [makeObservation(4)],
        currentObservation: makeObservation(2),
      });

      expect(codes(state)).toContain("OBSERVATION_STEPS_NOT_ASCENDING");
    });
  });

  describe("elements", () => {
    // "Unreachable" is only provable against a known set, so the keyboard can
    // never have reached something discovery never registered.
    it("requires visited elements to have been discovered", () => {
      const state = makeState({
        visitedElementIds: [elementId("a"), elementId("ghost")],
      });

      expect(codes(state)).toContain("VISITED_NOT_DISCOVERED");
    });

    it("rejects duplicate element ids", () => {
      const state = makeState({
        discoveredElements: [makeElement("a"), makeElement("a")],
      });

      expect(codes(state)).toContain("DUPLICATE_ELEMENT_ID");
    });

    it("rejects an element recorded as visited twice", () => {
      const state = makeState({
        visitedElementIds: [elementId("a"), elementId("a")],
      });

      expect(codes(state)).toContain("DUPLICATE_VISITED_ID");
    });

    it("requires the focused element to be both discovered and visited", () => {
      const stranger = makeElement("stranger");
      const state = makeState({ currentFocus: focusOn(stranger) });
      const found = codes(state);

      expect(found).toContain("FOCUSED_ELEMENT_NOT_DISCOVERED");
      expect(found).toContain("FOCUSED_ELEMENT_NOT_VISITED");
    });

    it("allows focus that is not on an element", () => {
      expect(codes(makeState({ currentFocus: { kind: "OUTSIDE_PAGE" } }))).toEqual([]);
      expect(codes(makeState({ currentFocus: { kind: "BODY" } }))).toEqual([]);
    });
  });

  describe("keyboard history", () => {
    // The evidence in every finding is built from keyboardHistory while `steps`
    // is what actually happened. If they drift, findings stop being replayable.
    it("requires history to match the actions the steps executed", () => {
      const state = makeState({
        keyboardHistory: [{ step: 0, action: "SHIFT_TAB", at: at(0) }],
      });

      expect(codes(state)).toContain("KEYBOARD_HISTORY_MISMATCH");
    });

    it("rejects history longer than the executed actions", () => {
      const state = makeState({
        keyboardHistory: [
          { step: 0, action: "TAB", at: at(0) },
          { step: 1, action: "TAB", at: at(1) },
        ],
      });

      expect(codes(state)).toContain("KEYBOARD_HISTORY_MISMATCH");
    });

    // A STOP step presses nothing, so it must not appear in the history.
    it("does not count a step that executed no action", () => {
      const state = makeState({
        currentStep: 2,
        steps: [makeStep(0, "TAB"), makeStep(1, null)],
      });

      expect(codes(state)).toEqual([]);
    });

    it("flags a non-allowlisted action that reached the history", () => {
      const state = makeState({
        steps: [
          makeStep(0, "TAB", {
            // Simulates a bug that bypassed the guard: the type is asserted
            // away here precisely because the type system would not allow it.
            executedAction: "ENTER" as never,
          }),
        ],
        keyboardHistory: [{ step: 0, action: "ENTER" as never, at: at(0) }],
      });

      expect(codes(state)).toContain("KEYBOARD_ACTION_NOT_ALLOWLISTED");
    });
  });

  describe("navigation graph", () => {
    it("rejects an edge pointing at a node that does not exist", () => {
      const state = makeState({
        navigationGraph: {
          nodes: [
            {
              id: nodeId("n0"),
              url: TEST_URL,
              focusKind: "ELEMENT",
              elementId: elementId("a"),
              role: "button",
              accessibleName: "A",
              firstSeenAtStep: 0,
              visitCount: 1,
            },
          ],
          edges: [
            {
              from: nodeId("n0"),
              to: nodeId("n404"),
              action: "TAB",
              atStep: 0,
              at: at(0),
            },
          ],
        },
      });

      expect(codes(state)).toContain("GRAPH_EDGE_DANGLING");
    });

    // A single-element trap is exactly this: press Tab, go nowhere.
    it("allows a self-edge", () => {
      const state = makeState({
        navigationGraph: {
          nodes: [
            {
              id: nodeId("n0"),
              url: TEST_URL,
              focusKind: "ELEMENT",
              elementId: elementId("a"),
              role: "button",
              accessibleName: "A",
              firstSeenAtStep: 0,
              visitCount: 2,
            },
          ],
          edges: [
            {
              from: nodeId("n0"),
              to: nodeId("n0"),
              action: "TAB",
              atStep: 0,
              at: at(0),
            },
          ],
        },
      });

      expect(codes(state)).toEqual([]);
    });
  });

  describe("findings", () => {
    it("rejects the same id in both buckets", () => {
      const state = makeState({
        suspectedFindings: [
          {
            id: findingId("f1"),
            status: "SUSPECTED",
            details: {
              type: "SUSPICIOUS_FOCUS_ORDER",
              observedOrder: [],
              expectedOrder: [],
            },
            reasoning: "Order looks scrambled.",
            confidence: 0.5 as never,
            detectedAtStep: 0,
            detectedAt: at(0),
          },
        ],
        confirmedFindings: [makeConfirmedFinding("f1")],
      });

      const found = codes(state);
      expect(found).toContain("FINDING_IN_BOTH_BUCKETS");
      expect(found).toContain("DUPLICATE_FINDING_ID");
    });

    it("rejects evidence referencing a screenshot the run never captured", () => {
      const state = makeState({
        confirmedFindings: [
          makeConfirmedFinding("f1", {
            evidence: makeEvidence({ screenshotIds: [screenshotId("never-taken")] }),
          }),
        ],
      });

      expect(codes(state)).toContain("EVIDENCE_SCREENSHOT_MISSING");
    });

    it("accepts evidence referencing a captured screenshot", () => {
      const state = makeState({
        confirmedFindings: [
          makeConfirmedFinding("f1", {
            evidence: makeEvidence({ screenshotIds: [screenshotId("shot-0")] }),
          }),
        ],
      });

      expect(codes(state)).toEqual([]);
    });

    // Evidence runs from step 0. A sequence starting mid-run cannot be replayed
    // from a cold browser, which is the whole point of recording it.
    it("requires the evidence sequence to be a prefix of the run", () => {
      const state = makeState({
        confirmedFindings: [
          makeConfirmedFinding("f1", {
            evidence: makeEvidence({ keyboardSequence: ["SHIFT_TAB"] }),
          }),
        ],
      });

      expect(codes(state)).toContain("EVIDENCE_SEQUENCE_NOT_PREFIX");
    });

    it("rejects an evidence sequence longer than the run", () => {
      const state = makeState({
        confirmedFindings: [
          makeConfirmedFinding("f1", {
            evidence: makeEvidence({ keyboardSequence: ["TAB", "TAB", "TAB"] }),
          }),
        ],
      });

      expect(codes(state)).toContain("EVIDENCE_SEQUENCE_NOT_PREFIX");
    });

    it("rejects an inverted step range", () => {
      const state = makeState({
        confirmedFindings: [
          makeConfirmedFinding("f1", {
            evidence: makeEvidence({ steps: { from: 5, to: 2 } }),
          }),
        ],
      });

      expect(codes(state)).toContain("EVIDENCE_STEP_RANGE_INVERTED");
    });
  });

  describe("reporting", () => {
    // Fixing violations one crash at a time is how a debugging session becomes
    // an afternoon, so every problem is reported at once.
    it("reports every violation, not just the first", () => {
      const state = makeState({
        currentStep: 99,
        visitedElementIds: [elementId("ghost")],
      });

      const found = codes(state);
      expect(found).toContain("STEP_COUNT_MISMATCH");
      expect(found).toContain("VISITED_NOT_DISCOVERED");
      expect(found.length).toBeGreaterThan(1);
    });

    it("throws an error carrying the violations", () => {
      const state = makeState({ currentStep: 99 });

      expect(() => assertAgentStateInvariants(state)).toThrow(AgentStateInvariantError);

      try {
        assertAgentStateInvariants(state);
        expect.unreachable("expected a violation");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentStateInvariantError);
        if (error instanceof AgentStateInvariantError) {
          expect(error.violations.map((v) => v.code)).toContain("STEP_COUNT_MISMATCH");
          expect(error.message).toContain("STEP_COUNT_MISMATCH");
        }
      }
    });
  });
});
