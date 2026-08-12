import { detectCycles } from "@/lib/graph";
import {
  focusedElement,
  type AgentState,
  type ConfirmedFinding,
  type FindingDetails,
  type FocusState,
  type InteractiveElement,
  type KeyboardAction,
  type NavigationNode,
  type SuspectedFinding,
  type TerminationReason,
} from "@/lib/shared/domain";

import type {
  AiAnalysis,
  EvidenceSection,
  HtmlReportViewModel,
  JourneyStep,
  KeyboardAccessibilityReport,
  KeyboardJourney,
  NavigationMap,
  PotentialIssue,
  ReportFinding,
  ReportOverview,
  SuggestedFix,
} from "./report-model";

/**
 * Builds the report from the validated audit trace.
 *
 * Not from raw model output: the journey, the map, the reproduction paths and
 * the evidence all come from what the browser recorded, and only the fields
 * explicitly marked as the model's — explanation, likely cause, suggested fix —
 * carry its words.
 *
 * Findings that reached the report have already been through the validator
 * (`lib/rules`). Suspicions that did not are reported as **potential issues**,
 * without evidence or a reproduction path, because there is none.
 */

/** How each key is written for a reader. */
const ACTION_LABELS: Readonly<Record<KeyboardAction, string>> = Object.freeze({
  TAB: "Tab",
  SHIFT_TAB: "Shift+Tab",
});

/**
 * Stated in the report itself, not left to whoever renders it.
 *
 * A surface that omitted these could present the findings as a conformance
 * verdict simply by saying nothing.
 */
const LIMITATIONS: readonly string[] = Object.freeze([
  "This audit used only Tab and Shift+Tab. Controls that need Enter, Space, Escape or the arrow keys were not activated, so problems reachable only that way were not tested.",
  "This report makes no claim about WCAG conformance. It records observed keyboard behaviour and nothing more.",
  "There is no score. Coverage depends on how far the traversal got, so a count of findings is not a measure of how accessible the page is.",
  "Findings marked as potential issues were not established by the evidence. They are listed so you can see what the agent examined, not as defects.",
  "Absence of a finding is not evidence of absence. An unexplored region of the page produces no findings at all.",
]);

export type ReportInput = {
  readonly state: AgentState;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly terminationReason: TerminationReason;
  readonly method: {
    readonly provider: string;
    readonly model: string;
    readonly multimodal: boolean;
    readonly promptVersion: string;
  };
  /** Why suspicions were not confirmed, by finding type, when known. */
  readonly rejectionsByType?: Readonly<Record<string, readonly string[]>>;
};

export class ReportGenerator {
  #input: ReportInput;
  #elements: Map<string, InteractiveElement>;

  constructor(input: ReportInput) {
    this.#input = input;
    this.#elements = new Map(
      input.state.discoveredElements.map((element) => [element.id, element]),
    );
  }

  generate(): KeyboardAccessibilityReport {
    const { state } = this.#input;

    return {
      auditId: state.auditId,
      generatedAt: this.#input.completedAt,
      reportVersion: "1.0.0",
      overview: this.#overview(),
      navigationMap: this.#navigationMap(),
      keyboardJourney: this.#keyboardJourney(),
      confirmedIssues: state.confirmedFindings.map((finding) =>
        this.#reportFinding(finding),
      ),
      potentialIssues: state.suspectedFindings.map((finding) =>
        this.#potentialIssue(finding),
      ),
      evidence: this.#evidence(),
      aiAnalysis: this.#aiAnalysis(),
      suggestedFixes: this.#suggestedFixes(),
      limitations: LIMITATIONS,
    };
  }

  // -- 1. Overview ---------------------------------------------------------

  #overview(): ReportOverview {
    const { state } = this.#input;
    const reached = new Set(state.visitedElementIds);

    return {
      url: state.url,
      startedAt: this.#input.startedAt,
      completedAt: this.#input.completedAt,
      durationMs: Math.max(
        0,
        Date.parse(this.#input.completedAt) - Date.parse(this.#input.startedAt),
      ),
      stepsExecuted: state.steps.length,
      interactiveElementsDiscovered: state.discoveredElements.length,
      elementsReached: reached.size,
      elementsNotReached: state.discoveredElements.filter(
        (element) => !reached.has(element.id),
      ).length,
      confirmedIssueCount: state.confirmedFindings.length,
      potentialIssueCount: state.suspectedFindings.length,
      terminationReason: this.#input.terminationReason,
      method: this.#input.method,
    };
  }

  // -- 2. Keyboard navigation map ------------------------------------------

  #navigationMap(): NavigationMap {
    const { state } = this.#input;
    const graph = state.navigationGraph;
    const reached = new Set(state.visitedElementIds);

    return {
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        label: this.#nodeLabel(node),
        role: node.role,
        elementId: node.elementId,
        firstSeenAtStep: node.firstSeenAtStep,
        visitCount: node.visitCount,
      })),
      edges: graph.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        action: edge.action,
        actionLabel: ACTION_LABELS[edge.action],
        atStep: edge.atStep,
      })),
      cycles: detectCycles(graph).map((cycle) => [...cycle.nodes]),
      unreachedElements: state.discoveredElements
        .filter((element) => !reached.has(element.id))
        .map((element) => ({
          elementId: element.id,
          label: this.#elementLabel(element),
        })),
    };
  }

  // -- 3. Exact keyboard journey -------------------------------------------

  /**
   * The journey, as a reader would replay it.
   *
   * Numbered from one and taken from the executed steps, so it is the sequence
   * that actually happened rather than the sequence the model asked for. A step
   * whose keypress was rejected never appears, because it never occurred.
   */
  #keyboardJourney(): KeyboardJourney {
    const { state } = this.#input;
    const steps: JourneyStep[] = [];

    let ordinal = 0;
    let previousFocus: FocusState = { kind: "UNKNOWN" };

    const first = state.steps[0];
    if (first !== undefined) previousFocus = first.observation.focus;

    for (const step of state.steps) {
      if (step.executedAction === null) continue;

      ordinal += 1;

      // The observation of the step *after* this one is where this keypress
      // landed; the last keypress landed on the current focus.
      const next = state.steps[state.steps.indexOf(step) + 1];
      const landedFocus = next?.observation.focus ?? state.currentFocus;
      const element = focusedElement(landedFocus);

      steps.push({
        ordinal,
        step: step.index,
        action: step.executedAction,
        actionLabel: ACTION_LABELS[step.executedAction],
        landedOn: this.#focusLabel(landedFocus),
        landedOnElementId: element?.id ?? null,
        focusChanged: !sameFocus(previousFocus, landedFocus),
      });

      previousFocus = landedFocus;
    }

    return {
      startedFrom: this.#focusLabel(
        state.steps[0]?.observation.focus ?? { kind: "UNKNOWN" },
      ),
      steps,
      sequence: steps.map((step) => step.actionLabel),
    };
  }

  // -- 4. Findings ---------------------------------------------------------

  #reportFinding(finding: ConfirmedFinding): ReportFinding {
    const element = this.#elementOf(finding.details);

    return {
      id: finding.id,
      standing: "CONFIRMED_ISSUE",
      type: finding.details.type,
      title: finding.suggestedFix,
      severity: finding.severity,
      confidence: finding.confidence,
      affectedElement:
        element === null
          ? null
          : {
              elementId: element.id,
              label: this.#elementLabel(element),
              role: element.role,
              selector: element.selector,
            },
      expected: expectedFor(finding.details, this.#labelFor.bind(this)),
      actual: actualFor(finding.details, this.#labelFor.bind(this)),
      reproduction: {
        sequence: finding.evidence.keyboardSequence.map(
          (action) => ACTION_LABELS[action],
        ),
        focusPath: finding.evidence.focusSequence.map((focus) => this.#focusLabel(focus)),
        steps: finding.evidence.steps,
      },
      screenshotIds: [...finding.evidence.screenshotIds],
      ariaEvidence: finding.evidence.ariaEvidence.snapshot,
      domEvidence: finding.evidence.domEvidence.summary,
      aiExplanation: finding.reasoning,
      likelyCause: finding.likelyCause,
      suggestedFix: finding.suggestedFix,
    };
  }

  #potentialIssue(finding: SuspectedFinding): PotentialIssue {
    return {
      id: finding.id,
      standing: "POTENTIAL_ISSUE",
      type: finding.details.type,
      confidence: finding.confidence,
      raisedAtStep: finding.detectedAtStep,
      aiExplanation: finding.reasoning,
      notConfirmedBecause: this.#input.rejectionsByType?.[finding.details.type] ?? [
        "The audit trace did not establish this.",
      ],
    };
  }

  // -- 5. Evidence ---------------------------------------------------------

  #evidence(): EvidenceSection {
    const { state } = this.#input;
    const byStep = new Map(state.steps.map((step) => [step.index, step]));

    return {
      items: state.screenshots.map((screenshot) => {
        const step = byStep.get(screenshot.step);

        return {
          step: screenshot.step,
          screenshotId: screenshot.id,
          screenshotPath: screenshot.path,
          action:
            step?.executedAction == null ? null : ACTION_LABELS[step.executedAction],
          focus: this.#focusLabel(step?.observation.focus ?? { kind: "UNKNOWN" }),
          url: state.url,
        };
      }),
      screenshotCount: state.screenshots.length,
      anyCaptureTruncated: state.steps.some(
        (step) => step.observation.dom.truncated || step.observation.aria.truncated,
      ),
    };
  }

  // -- 6. AI analysis ------------------------------------------------------

  #aiAnalysis(): AiAnalysis {
    const { state } = this.#input;

    const aiSteps = state.steps.filter((step) => step.decidedBy === "AI");

    return {
      // Only the model's decisions. Counting deterministic sweeps here would
      // overstate what the AI did and make two runs incomparable.
      decisionsMade: aiSteps.length,
      sweptSteps: state.steps.length - aiSteps.length,
      investigationsOpened: state.investigations.length,
      investigationsConfirmed: state.investigations.filter(
        (each) => each.status === "CONFIRMED",
      ).length,
      investigationsAbandoned: state.investigations.filter(
        (each) => each.status === "ABANDONED",
      ).length,
      reasoningTrail: aiSteps.map((step) => ({
        step: step.index,
        decision: step.decision.decision,
        mode: step.mode,
        reason: step.decision.reason,
        confidence: step.decision.confidence,
      })),
    };
  }

  // -- 7. Suggested fixes --------------------------------------------------

  /** Only for confirmed issues. Advice for a problem nobody established is noise. */
  #suggestedFixes(): readonly SuggestedFix[] {
    return this.#input.state.confirmedFindings.map((finding) => {
      const element = this.#elementOf(finding.details);

      return {
        findingId: finding.id,
        title: finding.suggestedFix,
        severity: finding.severity,
        fix: finding.likelyCause,
        affectedElementLabel: element === null ? null : this.#elementLabel(element),
      };
    });
  }

  // -- labels --------------------------------------------------------------

  #elementOf(details: FindingDetails): InteractiveElement | null {
    if (details.type === "UNREACHABLE_ELEMENT") {
      return this.#elements.get(details.elementId) ?? null;
    }
    return null;
  }

  #labelFor(elementId: string): string {
    const element = this.#elements.get(elementId);
    return element === undefined ? elementId : this.#elementLabel(element);
  }

  #elementLabel(element: InteractiveElement): string {
    return element.accessibleName ?? element.role ?? element.tagName;
  }

  #nodeLabel(node: NavigationNode): string {
    if (node.accessibleName !== null) return node.accessibleName;
    if (node.role !== null) return node.role;

    switch (node.focusKind) {
      case "BODY":
        return "the document body";
      case "OUTSIDE_PAGE":
        return "outside the page";
      case "UNKNOWN":
        return "not yet observed";
      default:
        return node.elementId ?? node.id;
    }
  }

  #focusLabel(focus: FocusState): string {
    const element = focusedElement(focus);
    if (element !== null) return this.#elementLabel(element);

    switch (focus.kind) {
      case "BODY":
        return "the document body";
      case "OUTSIDE_PAGE":
        return "outside the page (browser chrome)";
      default:
        return "not observed";
    }
  }
}

/**
 * What a keyboard user should have been able to do.
 *
 * Every branch states a fact about the document or a plain requirement — never
 * an intended order the page did not declare. Asserting one would be exactly
 * the fabrication the whole evidence model is built to avoid.
 */
function expectedFor(
  details: FindingDetails,
  label: (elementId: string) => string,
): string {
  switch (details.type) {
    case "UNREACHABLE_ELEMENT":
      return `"${label(details.elementId)}" is an interactive control, so keyboard traversal should be able to reach it.`;
    case "SUSPICIOUS_FOCUS_ORDER":
      return `Focus order should follow the document order: ${details.expectedOrder
        .map((id) => `"${label(id)}"`)
        .join(" → ")}.`;
    case "UNEXPECTED_FOCUS_LEAVING_PAGE":
      return "Focus should stay within the application while controls remain to be reached.";
    case "SUSPICIOUS_FOCUS_CYCLE":
      return "Continued tabbing should eventually reach every control, not return to a fixed set.";
    case "NO_KEYBOARD_REACHABLE_CONTROLS":
      return `The page offers ${details.discoveredCount} interactive controls, so the keyboard should reach at least one.`;
  }
}

/** What the trace recorded instead. */
function actualFor(
  details: FindingDetails,
  label: (elementId: string) => string,
): string {
  switch (details.type) {
    case "UNREACHABLE_ELEMENT":
      return `Keyboard traversal never focused "${label(details.elementId)}".`;
    case "SUSPICIOUS_FOCUS_ORDER":
      return `Focus arrived in this order: ${details.observedOrder
        .map((id) => `"${label(id)}"`)
        .join(" → ")}.`;
    case "UNEXPECTED_FOCUS_LEAVING_PAGE":
      return `At step ${details.atStep}, focus left the document for browser chrome.`;
    case "SUSPICIOUS_FOCUS_CYCLE":
      return `Focus cycled through ${details.cycleElementIds
        .map((id) => `"${label(id)}"`)
        .join(" → ")}, never reaching ${
        details.excludedElementIds.length
      } other discovered control(s).`;
    case "NO_KEYBOARD_REACHABLE_CONTROLS":
      return "Keyboard traversal focused none of them.";
  }
}

function sameFocus(a: FocusState, b: FocusState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ELEMENT" && b.kind === "ELEMENT") return a.element.id === b.element.id;
  return true;
}

// ---------------------------------------------------------------------------

const SECTION_TITLES = Object.freeze([
  ["overview", "Overview", "What was audited, and how far the traversal got."],
  [
    "navigation-map",
    "Keyboard navigation map",
    "Where focus travelled, as a graph of positions and the keys between them.",
  ],
  [
    "keyboard-journey",
    "Exact keyboard journey",
    "Every keypress in order, and where focus landed. Replay this from a fresh page load.",
  ],
  [
    "findings",
    "Findings",
    "Confirmed issues, each backed by the recorded trace. Potential issues are listed separately and were not established.",
  ],
  ["evidence", "Evidence", "Screenshots and captures taken at each step."],
  [
    "ai-analysis",
    "AI analysis",
    "What the agent decided at each step and why. This is interpretation, not observation.",
  ],
  [
    "suggested-fixes",
    "Suggested fixes",
    "Proposed remedies for confirmed issues. Written by the model; review before acting.",
  ],
] as const);

/**
 * Shapes the report for rendering.
 *
 * The phrasing lives here rather than in templates, so "confirmed issue" and
 * "potential issue" mean the same thing on every surface that shows them.
 */
export function toHtmlReportViewModel(
  report: KeyboardAccessibilityReport,
): HtmlReportViewModel {
  const emptiness: Readonly<Record<string, boolean>> = {
    overview: false,
    "navigation-map": report.navigationMap.nodes.length === 0,
    "keyboard-journey": report.keyboardJourney.steps.length === 0,
    findings: report.confirmedIssues.length === 0 && report.potentialIssues.length === 0,
    evidence: report.evidence.items.length === 0,
    "ai-analysis": report.aiAnalysis.reasoningTrail.length === 0,
    "suggested-fixes": report.suggestedFixes.length === 0,
  };

  return {
    title: "Keyboard accessibility audit",
    subtitle: `${report.overview.url} — ${report.overview.confirmedIssueCount} confirmed issue(s), ${report.overview.potentialIssueCount} potential issue(s)`,
    sections: SECTION_TITLES.map(([id, title, summary]) => ({
      id,
      title,
      summary,
      isEmpty: emptiness[id] ?? false,
    })),
    report,
    severityOrder: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
  };
}
