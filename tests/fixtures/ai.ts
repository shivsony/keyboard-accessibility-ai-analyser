import type { AgentAnalysisInput } from "@/lib/ai";
import { elementId, focusOn } from "@/lib/shared/domain";

import { makeElement, makeObservation, TEST_AUDIT_ID, TEST_URL } from "./domain";

/**
 * A plausible analysis input.
 *
 * Defaults to a mid-traversal state — two controls found, one reached, one Tab
 * pressed — because an input with no history exercises none of the branches
 * that make the prompt worth building.
 */
/** PNG magic number plus a few bytes. Enough to pass validation. */
export const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02,
]);

export function makeAnalysisInput(
  overrides: Partial<AgentAnalysisInput> = {},
): AgentAnalysisInput {
  const logo = makeElement("logo", { accessibleName: "Logo", role: "link" });
  const search = makeElement("search", {
    accessibleName: "Search",
    role: "searchbox",
  });

  return {
    auditId: TEST_AUDIT_ID,
    url: TEST_URL,
    step: 1,
    observation: makeObservation(1, { focus: focusOn(logo) }),
    previousObservations: [makeObservation(0)],
    discoveredElements: [logo, search],
    visitedElementIds: [elementId("logo")],
    keyboardHistory: [{ step: 0, action: "TAB", at: "2026-08-10T12:00:00.000Z" }],
    navigationSummary: "Logo --TAB--> Search",
    suspectedFindings: [],
    // A valid, if tiny, PNG. The realistic default: every observation carries a
    // screenshot, and a provider in `required` mode fails the step without one.
    screenshot: TINY_PNG,
    stepsRemaining: 149,
    ...overrides,
  };
}

/** A valid decision as the model would return it, before parsing. */
export const RAW_CONTINUE = {
  decision: "CONTINUE",
  action: "TAB",
  reason: "Still traversing the header.",
  confidence: 0.8,
  suspectedIssue: null,
  issue: null,
  targetElementId: null,
};

/** A valid REPORT, as the model would return it. */
export const RAW_REPORT = {
  decision: "REPORT",
  action: null,
  reason: "Two full traversals never focused this control.",
  confidence: 0.96,
  suspectedIssue: null,
  issue: {
    type: "UNREACHABLE_ELEMENT",
    severity: "HIGH",
    title: "Delete account button cannot be reached by keyboard",
    description: "A div with role=button and no tabindex.",
  },
  targetElementId: null,
};
