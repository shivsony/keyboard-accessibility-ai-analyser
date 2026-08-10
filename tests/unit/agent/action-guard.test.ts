import { describe, expect, it } from "vitest";

import { guardDecision, rejectMalformed, validateDecision } from "@/lib/agent";
import { parseAgentDecision } from "@/lib/shared/domain";

/**
 * The guard is the security boundary of the loop.
 *
 * It is deterministic, has no bypass, and runs on every step. These tests are
 * the record of what it refuses.
 */

const CONTINUE = parseAgentDecision({
  decision: "CONTINUE",
  action: "TAB",
  reason: "Keep traversing.",
  confidence: 0.9,
});

const STOP = parseAgentDecision({
  decision: "STOP",
  reason: "Done.",
  confidence: 0.9,
});

const REPORT = parseAgentDecision({
  decision: "REPORT",
  reason: "Never reached.",
  confidence: 0.95,
  issue: {
    type: "UNREACHABLE_ELEMENT",
    severity: "HIGH",
    title: "Unreachable control",
    description: "Tab never lands on it.",
  },
});

describe("validateDecision", () => {
  it("accepts a decision that meets the schema", () => {
    const result = validateDecision(CONTINUE);

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.decision.decision).toBe("CONTINUE");
  });

  // `AIProvider` is an interface. A second implementation, a stub, or a bug
  // could return something that never met the schema, and the loop declines to
  // trust every present and future provider.
  it("rejects output that never passed the schema", () => {
    const result = validateDecision({
      decision: "CONTINUE",
      action: "ENTER",
      reason: "Press Enter.",
      confidence: 0.9,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.problem).toContain("action");
  });

  it.each([null, undefined, "TAB", 42, {}, []])("rejects %s", (input) => {
    expect(validateDecision(input).valid).toBe(false);
  });
});

describe("guardDecision", () => {
  it("approves an allowlisted action", () => {
    expect(guardDecision(CONTINUE)).toEqual({ outcome: "APPROVED", action: "TAB" });
  });

  it("approves SHIFT_TAB", () => {
    const decision = parseAgentDecision({ ...CONTINUE, action: "SHIFT_TAB" });

    expect(guardDecision(decision)).toEqual({
      outcome: "APPROVED",
      action: "SHIFT_TAB",
    });
  });

  // Nothing to approve and nothing to refuse: a distinct outcome, so the record
  // does not read as a rejection.
  it("returns NO_ACTION for decisions that do not move", () => {
    expect(guardDecision(STOP)).toEqual({ outcome: "NO_ACTION" });
    expect(guardDecision(REPORT)).toEqual({ outcome: "NO_ACTION" });
  });

  // The schema already blocks these; the guard checks again because it is the
  // last thing between a decision and a real keypress.
  it.each(["ENTER", "SPACE", "ESCAPE", "Tab", "tab", ""])(
    "refuses the smuggled action %s",
    (action) => {
      const smuggled = { ...CONTINUE, action } as never;

      expect(guardDecision(smuggled)).toMatchObject({
        outcome: "REJECTED",
        reason: "ACTION_NOT_ALLOWLISTED",
      });
    },
  );

  // A model repeatedly asking for a key it cannot have is a signal, so the
  // request is kept rather than discarded.
  it("retains the refused request as evidence", () => {
    const verdict = guardDecision({ ...CONTINUE, action: "ENTER" } as never);

    if (verdict.outcome !== "REJECTED") return expect.unreachable("expected REJECTED");
    expect(verdict.requested).toBe("ENTER");
  });
});

describe("rejectMalformed", () => {
  it("records why a decision could not be read", () => {
    const verdict = rejectMalformed("action: invalid enum value");

    expect(verdict).toEqual({
      outcome: "REJECTED",
      requested: "action: invalid enum value",
      reason: "MALFORMED_DECISION",
    });
  });
});
