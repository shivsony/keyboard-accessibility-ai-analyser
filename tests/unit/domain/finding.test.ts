import { describe, expect, it } from "vitest";

import {
  ConfirmedFindingSchema,
  FindingSchema,
  FindingTypeSchema,
  isConfirmed,
  isSuspected,
  SuspectedFindingSchema,
  type Finding,
} from "@/lib/shared/domain";
import { at, makeConfirmedFinding, makeEvidence } from "../../fixtures/domain";

const SUSPECTED = {
  id: "f1",
  status: "SUSPECTED",
  details: {
    type: "SUSPICIOUS_FOCUS_CYCLE",
    cycleElementIds: ["a", "b"],
    excludedElementIds: ["c"],
  },
  reasoning: "Focus returned to the first control without reaching the dialog body.",
  confidence: 0.7,
  detectedAtStep: 4,
  detectedAt: at(4),
};

describe("finding types", () => {
  it("covers exactly the five MVP findings", () => {
    expect([...FindingTypeSchema.options]).toEqual([
      "UNREACHABLE_INTERACTIVE_ELEMENT",
      "SUSPICIOUS_FOCUS_ORDER",
      "UNEXPECTED_FOCUS_LEAVING_PAGE",
      "SUSPICIOUS_FOCUS_CYCLE",
      "NO_KEYBOARD_REACHABLE_CONTROLS",
    ]);
  });

  it("rejects an out-of-scope finding type", () => {
    expect(FindingTypeSchema.safeParse("COLOR_CONTRAST").success).toBe(false);
  });
});

describe("finding details", () => {
  // Each finding type carries different particulars; the union keeps consumers
  // from having to guess which optional fields happen to be populated.
  it("requires the fields that belong to the type", () => {
    expect(
      SuspectedFindingSchema.safeParse({
        ...SUSPECTED,
        details: { type: "UNREACHABLE_INTERACTIVE_ELEMENT" },
      }).success,
    ).toBe(false);

    expect(
      SuspectedFindingSchema.safeParse({
        ...SUSPECTED,
        details: { type: "UNREACHABLE_INTERACTIVE_ELEMENT", elementId: "a" },
      }).success,
    ).toBe(true);
  });

  it("rejects fields borrowed from a different finding type", () => {
    expect(
      SuspectedFindingSchema.safeParse({
        ...SUSPECTED,
        details: { type: "NO_KEYBOARD_REACHABLE_CONTROLS", cycleElementIds: ["a"] },
      }).success,
    ).toBe(false);
  });

  // The finding says the page has controls and none are reachable. Zero
  // controls is a different situation, and not this one.
  it("requires NO_KEYBOARD_REACHABLE_CONTROLS to have found controls", () => {
    expect(
      SuspectedFindingSchema.safeParse({
        ...SUSPECTED,
        details: { type: "NO_KEYBOARD_REACHABLE_CONTROLS", discoveredCount: 0 },
      }).success,
    ).toBe(false);

    expect(
      SuspectedFindingSchema.safeParse({
        ...SUSPECTED,
        details: { type: "NO_KEYBOARD_REACHABLE_CONTROLS", discoveredCount: 3 },
      }).success,
    ).toBe(true);
  });
});

describe("suspected vs confirmed", () => {
  // A suspicion is working state. Only a confirmed finding is a result, and it
  // has to carry everything a reader needs to act.
  it("does not let a suspected finding pose as reportable", () => {
    const suspected = SuspectedFindingSchema.parse(SUSPECTED);

    expect(isSuspected(suspected)).toBe(true);
    expect(isConfirmed(suspected)).toBe(false);
    expect(suspected).not.toHaveProperty("evidence");
    expect(suspected).not.toHaveProperty("severity");
  });

  it.each(["severity", "evidence", "likelyCause", "suggestedFix"])(
    "requires %s on a confirmed finding",
    (field) => {
      const finding: Record<string, unknown> = { ...makeConfirmedFinding("f1") };
      delete finding[field];

      expect(ConfirmedFindingSchema.safeParse(finding).success).toBe(false);
    },
  );

  it("rejects an empty suggested fix — a fix nobody can act on is not one", () => {
    expect(
      ConfirmedFindingSchema.safeParse(makeConfirmedFinding("f1", { suggestedFix: "" }))
        .success,
    ).toBe(false);
  });

  it("narrows on status", () => {
    const finding: Finding = FindingSchema.parse(makeConfirmedFinding("f1"));

    if (isConfirmed(finding)) {
      expect(finding.evidence.keyboardSequence).toEqual(["TAB"]);
      expect(finding.severity).toBe("HIGH");
    } else {
      expect.unreachable("expected a confirmed finding");
    }
  });
});

describe("finding evidence", () => {
  it("accepts a full reproduction bundle", () => {
    const finding = ConfirmedFindingSchema.parse(makeConfirmedFinding("f1"));

    expect(finding.evidence.keyboardSequence).toEqual(["TAB"]);
    expect(finding.evidence.steps).toEqual({ from: 0, to: 0 });
  });

  it("rejects a negative step in the range", () => {
    expect(
      ConfirmedFindingSchema.safeParse(
        makeConfirmedFinding("f1", {
          evidence: makeEvidence({ steps: { from: -1, to: 2 } }),
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects a keyboard sequence containing a key outside the allowlist", () => {
    expect(
      ConfirmedFindingSchema.safeParse(
        makeConfirmedFinding("f1", {
          evidence: makeEvidence({ keyboardSequence: ["TAB", "ENTER" as never] }),
        }),
      ).success,
    ).toBe(false);
  });
});
