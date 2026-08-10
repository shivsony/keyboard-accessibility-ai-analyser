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
    screenshot: null,
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
