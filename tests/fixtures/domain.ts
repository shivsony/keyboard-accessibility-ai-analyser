/**
 * Builders for domain objects under test.
 *
 * Every builder returns a valid, coherent value and takes an overrides object,
 * so a test can state the one thing it cares about and let the rest be
 * plausible. Tests that assert on invariants need a *correct* baseline to break
 * deliberately — otherwise a passing test only proves the fixture was wrong in
 * some other way.
 */

import type {
  AccessibilitySnapshot,
  AgentDecision,
  AgentObservation,
  AgentState,
  AgentStep,
  ConfirmedFinding,
  DOMSnapshot,
  FindingEvidence,
  InteractiveElement,
  KeyboardAction,
  NavigationGraph,
  ScreenshotEvidence,
  Viewport,
} from "@/lib/shared/domain";
import {
  auditId,
  confidence,
  elementId,
  findingId,
  focusOn,
  nodeId,
  screenshotId,
  createInitialAgentState,
  FOCUS_UNKNOWN,
} from "@/lib/shared/domain";

export const TEST_URL = "https://example.test/app";
export const TEST_AUDIT_ID = auditId("audit-1");

const T0 = "2026-08-10T12:00:00.000Z";

export function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

export const VIEWPORT: Viewport = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
};

export function makeElement(
  id: string,
  overrides: Partial<InteractiveElement> = {},
): InteractiveElement {
  return {
    id: elementId(id),
    tagName: "button",
    role: "button",
    accessibleName: `Element ${id}`,
    selector: `#${id}`,
    tabIndex: 0,
    disabled: false,
    visible: true,
    boundingBox: { x: 0, y: 0, width: 100, height: 32 },
    discoveredVia: "NATIVE_CONTROL",
    discoveredAtStep: 0,
    ...overrides,
  };
}

export function makeDomSnapshot(overrides: Partial<DOMSnapshot> = {}): DOMSnapshot {
  return {
    summary: "<main><button id=\"a\">A</button></main>",
    nodeCount: 4,
    truncated: false,
    capturedAt: at(0),
    ...overrides,
  };
}

export function makeAriaSnapshot(
  overrides: Partial<AccessibilitySnapshot> = {},
): AccessibilitySnapshot {
  return {
    root: {
      role: "main",
      name: null,
      value: null,
      focused: false,
      disabled: false,
      children: [
        {
          role: "button",
          name: "A",
          value: null,
          focused: true,
          disabled: false,
          children: [],
        },
      ],
    },
    nodeCount: 2,
    truncated: false,
    capturedAt: at(0),
    ...overrides,
  };
}

export function makeScreenshot(
  id: string,
  step: number,
  overrides: Partial<ScreenshotEvidence> = {},
): ScreenshotEvidence {
  return {
    id: screenshotId(id),
    path: `steps/${String(step).padStart(4, "0")}.png`,
    step,
    viewport: VIEWPORT,
    capturedAt: at(step),
    format: "png",
    ...overrides,
  };
}

export function makeObservation(
  step: number,
  overrides: Partial<AgentObservation> = {},
): AgentObservation {
  return {
    step,
    url: TEST_URL,
    screenshotId: screenshotId(`shot-${step}`),
    focus: FOCUS_UNKNOWN,
    dom: makeDomSnapshot(),
    aria: makeAriaSnapshot(),
    interactiveElements: [],
    viewport: VIEWPORT,
    timestamp: at(step),
    ...overrides,
  };
}

export function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    decision: "CONTINUE",
    action: "TAB",
    reasoning: "Nothing notable; keep traversing.",
    confidence: confidence(0.8),
    suspectedIssue: null,
    targetElementId: null,
    ...overrides,
  } as AgentDecision;
}

export function makeStep(
  index: number,
  action: KeyboardAction | null = "TAB",
  overrides: Partial<AgentStep> = {},
): AgentStep {
  return {
    index,
    observation: makeObservation(index),
    decision:
      action === null
        ? {
            decision: "STOP",
            action: null,
            reasoning: "Traversal complete.",
            confidence: confidence(0.9),
            suspectedIssue: null,
            targetElementId: null,
          }
        : makeDecision({ action }),
    guardVerdict:
      action === null ? { outcome: "NO_ACTION" } : { outcome: "APPROVED", action },
    executedAction: action,
    startedAt: at(index),
    completedAt: at(index + 1),
    ...overrides,
  };
}

export function makeEvidence(
  overrides: Partial<FindingEvidence> = {},
): FindingEvidence {
  return {
    keyboardSequence: ["TAB"],
    focusSequence: [FOCUS_UNKNOWN],
    screenshotIds: [],
    domEvidence: makeDomSnapshot(),
    ariaEvidence: makeAriaSnapshot(),
    steps: { from: 0, to: 0 },
    ...overrides,
  };
}

export function makeConfirmedFinding(
  id: string,
  overrides: Partial<ConfirmedFinding> = {},
): ConfirmedFinding {
  return {
    id: findingId(id),
    status: "CONFIRMED",
    details: {
      type: "UNREACHABLE_INTERACTIVE_ELEMENT",
      elementId: elementId("a"),
    },
    reasoning: "Tab traversal cycled without ever focusing this control.",
    confidence: confidence(0.9),
    detectedAtStep: 0,
    detectedAt: at(0),
    severity: "HIGH",
    evidence: makeEvidence(),
    likelyCause: "The control is a div with a click handler and no tabindex.",
    suggestedFix: "Use a <button>, or add tabindex=\"0\" and keyboard handling.",
    confirmedAtStep: 0,
    ...overrides,
  };
}

export function makeGraph(overrides: Partial<NavigationGraph> = {}): NavigationGraph {
  return {
    nodes: [
      {
        id: nodeId("n0"),
        url: TEST_URL,
        focusKind: "ELEMENT",
        elementId: elementId("a"),
        firstSeenAtStep: 0,
        visitCount: 1,
      },
    ],
    edges: [],
    ...overrides,
  };
}

/**
 * A small but fully coherent state: one element discovered and reached, one
 * step executed, focus resting on that element.
 */
export function makeState(overrides: Partial<AgentState> = {}): AgentState {
  const element = makeElement("a");

  return {
    ...createInitialAgentState({ auditId: TEST_AUDIT_ID, url: TEST_URL }),
    status: { kind: "RUNNING" },
    currentStep: 1,
    currentObservation: makeObservation(1, { focus: focusOn(element) }),
    previousObservations: [makeObservation(0)],
    currentFocus: focusOn(element),
    discoveredElements: [element],
    visitedElementIds: [element.id],
    keyboardHistory: [{ step: 0, action: "TAB", at: at(0) }],
    navigationGraph: makeGraph(),
    screenshots: [makeScreenshot("shot-0", 0), makeScreenshot("shot-1", 1)],
    steps: [makeStep(0, "TAB")],
    ...overrides,
  };
}
