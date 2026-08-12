import { describe, expect, it } from "vitest";

import { buildUserPrompt, DECISION_JSON_SCHEMA } from "@/lib/ai";
import { confidence, elementId, findingId, focusOn } from "@/lib/shared/domain";

import { makeElement, makeObservation } from "../../fixtures/domain";
import { makeAnalysisInput } from "../../fixtures/ai";

describe("decision schema", () => {
  it("permits only the allowlisted actions, plus null for STOP", () => {
    expect(DECISION_JSON_SCHEMA.properties.action.enum).toEqual([
      "TAB",
      "SHIFT_TAB",
      null,
    ]);
  });

  it("requires every field, so nothing arrives implicitly absent", () => {
    expect([...DECISION_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(DECISION_JSON_SCHEMA.properties).sort(),
    );
  });

  it("forbids extra properties", () => {
    expect(DECISION_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("user prompt", () => {
  it("states where focus is and how much budget is left", () => {
    const prompt = buildUserPrompt(makeAnalysisInput());

    expect(prompt).toContain("FOCUS IS NOW ON:");
    expect(prompt).toContain("Logo");
    expect(prompt).toContain("149 steps remain");
  });

  // Which controls have not been reached is the question behind the most
  // common finding, so it is stated rather than left to be inferred.
  it("marks which controls have not been reached", () => {
    const prompt = buildUserPrompt(makeAnalysisInput());

    expect(prompt).toContain("[logo]");
    expect(prompt).toContain("NOT REACHED");
    expect(prompt).toContain("1 not yet reached");
  });

  it("includes the keyboard history and the navigation summary", () => {
    const prompt = buildUserPrompt(makeAnalysisInput());

    expect(prompt).toContain("KEYBOARD HISTORY");
    expect(prompt).toContain("Logo --TAB--> Search");
  });

  it("says so when nothing has been pressed yet", () => {
    const prompt = buildUserPrompt(
      makeAnalysisInput({
        keyboardHistory: [],
        previousObservations: [],
        navigationSummary: "",
      }),
    );

    expect(prompt).toContain("(nothing pressed yet)");
    expect(prompt).toContain("(this is the first observation)");
  });

  // Focus leaving the page is a finding in its own right; it should not be
  // rendered as just another absence of focus.
  it("calls out focus that has left the page", () => {
    const prompt = buildUserPrompt(
      makeAnalysisInput({
        observation: makeObservation(1, { focus: { kind: "OUTSIDE_PAGE" } }),
      }),
    );

    expect(prompt).toContain("OUTSIDE THE PAGE");
  });

  it("carries hypotheses forward across steps", () => {
    const prompt = buildUserPrompt(
      makeAnalysisInput({
        suspectedFindings: [
          {
            id: findingId("f1"),
            status: "SUSPECTED",
            details: {
              type: "SUSPICIOUS_FOCUS_CYCLE",
              cycleElementIds: [elementId("a")],
              excludedElementIds: [],
            },
            reasoning: "Focus keeps returning to the first control.",
            confidence: confidence(0.6),
            detectedAtStep: 0,
            detectedAt: "2026-08-10T12:00:00.000Z",
          },
        ],
      }),
    );

    expect(prompt).toContain("PREVIOUS FINDINGS");
    expect(prompt).toContain("SUSPICIOUS_FOCUS_CYCLE");
  });

  // An unbounded page would blow up both the request and the run record.
  it("caps the element list and says how many were omitted", () => {
    const many = Array.from({ length: 80 }, (_unused, index) =>
      makeElement(`el-${index}`),
    );

    const prompt = buildUserPrompt(
      makeAnalysisInput({ discoveredElements: many, visitedElementIds: [] }),
    );

    expect(prompt).toContain("80 total");
    expect(prompt).toContain("68 more not listed");
  });

  // What bears on a decision is what has *not* been reached. Sending all
  // eighty controls every step was the single largest section of the prompt.
  it("lists unreached controls before reached ones", () => {
    const elements = [
      makeElement("reached-one", { accessibleName: "Reached one" }),
      makeElement("reached-two", { accessibleName: "Reached two" }),
      makeElement("missed", { accessibleName: "Missed" }),
    ];

    const prompt = buildUserPrompt(
      makeAnalysisInput({
        discoveredElements: elements,
        visitedElementIds: [elementId("reached-one"), elementId("reached-two")],
      }),
    );

    const listing = prompt.slice(prompt.indexOf("DISCOVERED INTERACTIVE ELEMENTS"));

    expect(listing.indexOf("Missed")).toBeLessThan(listing.indexOf("Reached one"));
  });

  // A prompt whose size depends on how long you have been running is a prompt
  // nobody has budgeted.
  it("caps the traversal summary rather than growing with the run", () => {
    const long = Array.from({ length: 200 }, (_u, i) => `Control ${i}`).join(
      " --TAB--> ",
    );

    const prompt = buildUserPrompt(makeAnalysisInput({ navigationSummary: long }));

    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(long.length);
  });

  // The loop that cost a real run six consecutive identical reports.
  it("tells the model which reports were already refused", () => {
    const prompt = buildUserPrompt(
      makeAnalysisInput({
        rejectedClaims: [
          {
            type: "UNEXPECTED_FOCUS_LEAVING_PAGE",
            reasons: ["the trace shows no UNEXPECTED_FOCUS_LEAVING_PAGE"],
          },
        ],
      }),
    );

    expect(prompt).toContain("ALREADY REPORTED AND REFUSED");
    expect(prompt).toContain("UNEXPECTED_FOCUS_LEAVING_PAGE");
  });

  it("names the reason it is being consulted", () => {
    const prompt = buildUserPrompt(
      makeAnalysisInput({ decisionPoint: "CANDIDATE_FINDING" }),
    );

    expect(prompt).toContain("YOU ARE BEING ASKED BECAUSE");
    expect(prompt).toContain("Judge whether it is real");
  });

  it("reports truncated captures as truncated", () => {
    const observation = makeObservation(1, { focus: focusOn(makeElement("logo")) });
    const prompt = buildUserPrompt(
      makeAnalysisInput({
        observation: {
          ...observation,
          dom: { ...observation.dom, truncated: true },
        },
      }),
    );

    expect(prompt).toContain("TRUNCATED");
  });
});
