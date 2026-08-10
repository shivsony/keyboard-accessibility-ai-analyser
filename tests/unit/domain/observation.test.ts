import { describe, expect, it } from "vitest";

import {
  AgentObservationSchema,
  FocusStateSchema,
  focusedElement,
  focusOn,
  FOCUS_BODY,
  FOCUS_OUTSIDE_PAGE,
  FOCUS_UNKNOWN,
} from "@/lib/shared/domain";
import { makeElement, makeObservation } from "../../fixtures/domain";

describe("AgentObservation", () => {
  it("carries everything the model is shown before it decides", () => {
    const observation = AgentObservationSchema.parse(makeObservation(3));

    expect(Object.keys(observation).sort()).toEqual([
      "aria",
      "dom",
      "focus",
      "interactiveElements",
      "screenshotId",
      "step",
      "timestamp",
      "url",
      "viewport",
    ]);
  });

  it.each([
    "screenshotId",
    "focus",
    "dom",
    "aria",
    "interactiveElements",
    "url",
    "viewport",
    "timestamp",
  ])("requires %s", (field) => {
    const observation: Record<string, unknown> = { ...makeObservation(0) };
    delete observation[field];

    expect(AgentObservationSchema.safeParse(observation).success).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    expect(
      AgentObservationSchema.safeParse(makeObservation(0, { timestamp: "yesterday" }))
        .success,
    ).toBe(false);
  });

  // Truncation has to travel with the evidence: an observation that silently
  // dropped half the page would make a finding unreproducible.
  it("records whether the DOM summary was truncated", () => {
    const observation = AgentObservationSchema.parse(
      makeObservation(0, {
        dom: { ...makeObservation(0).dom, truncated: true, nodeCount: 5000 },
      }),
    );

    expect(observation.dom.truncated).toBe(true);
    expect(observation.dom.nodeCount).toBe(5000);
  });

  it("retains the AI-oriented Playwright ARIA snapshot", () => {
    const observation = AgentObservationSchema.parse(makeObservation(0));

    expect(observation.aria.snapshot).toContain("[ref=e1]");
  });
});

describe("FocusState", () => {
  // "Focus is on nothing" has three meanings and only one of them is a finding,
  // so the union keeps them apart.
  it("distinguishes the ways focus can be on no element", () => {
    expect(FOCUS_UNKNOWN.kind).toBe("UNKNOWN");
    expect(FOCUS_BODY.kind).toBe("BODY");
    expect(FOCUS_OUTSIDE_PAGE.kind).toBe("OUTSIDE_PAGE");

    for (const focus of [FOCUS_UNKNOWN, FOCUS_BODY, FOCUS_OUTSIDE_PAGE]) {
      expect(focusedElement(focus)).toBeNull();
      expect(FocusStateSchema.safeParse(focus).success).toBe(true);
    }
  });

  it("carries the element when focus is on one", () => {
    const element = makeElement("a");
    const focus = focusOn(element);

    expect(FocusStateSchema.safeParse(focus).success).toBe(true);
    expect(focusedElement(focus)?.id).toBe("a");
  });

  it("rejects an ELEMENT focus with no element", () => {
    expect(FocusStateSchema.safeParse({ kind: "ELEMENT" }).success).toBe(false);
  });

  it("rejects an unknown focus kind", () => {
    expect(FocusStateSchema.safeParse({ kind: "IFRAME" }).success).toBe(false);
  });
});
