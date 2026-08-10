import { describe, expect, it } from "vitest";

import { applyObservation, applyTransition, appendStep } from "@/lib/agent";
import {
  KeyboardAccessibilityReportSchema,
  ReportGenerator,
  toHtmlReportViewModel,
  type ReportInput,
} from "@/lib/report";
import { FindingValidator } from "@/lib/rules";
import {
  createInitialAgentState,
  focusOn,
  type AgentState,
  type ReportedIssue,
} from "@/lib/shared/domain";

import {
  at,
  makeElement,
  makeObservation,
  makeScreenshot,
  makeStep,
  TEST_AUDIT_ID,
  TEST_URL,
} from "../../fixtures/domain";

/**
 * The report is built from the trace, not from what the model said.
 *
 * The tests that matter most here are the negative ones: no score, no
 * conformance claim, and no evidence attached to a suspicion the validator
 * refused.
 */

const LOGO = makeElement("logo", { accessibleName: "Logo", role: "link" });
const SEARCH = makeElement("search", { accessibleName: "Search" });
const MENU = makeElement("menu", { accessibleName: "Menu", role: "button" });
const FILTER = makeElement("filter", { accessibleName: "Filter", role: "button" });

const ALL = [LOGO, SEARCH, MENU, FILTER];

/** Logo → Search → Menu, with Filter never reached. */
function trace(): AgentState {
  let state = createInitialAgentState({ auditId: TEST_AUDIT_ID, url: TEST_URL });

  state = {
    ...state,
    screenshots: [
      makeScreenshot("shot-0", 0),
      makeScreenshot("shot-1", 1),
      makeScreenshot("shot-2", 2),
    ],
  };

  state = applyObservation(
    state,
    makeObservation(0, { focus: focusOn(LOGO), interactiveElements: ALL }),
  );

  const walk = [
    { to: SEARCH, from: LOGO, step: 0 },
    { to: MENU, from: SEARCH, step: 1 },
  ];

  for (const [index, move] of walk.entries()) {
    state = applyObservation(
      state,
      makeObservation(index + 1, { focus: focusOn(move.to), interactiveElements: ALL }),
    );
    state = applyTransition(state, {
      from: focusOn(move.from),
      to: focusOn(move.to),
      action: "TAB",
      step: move.step,
      at: at(move.step),
    });
    // The step records the observation it decided from — where focus was
    // *before* this keypress — matching what the loop stores.
    state = appendStep(
      state,
      makeStep(move.step, "TAB", {
        observation: makeObservation(move.step, {
          focus: focusOn(move.from),
          interactiveElements: ALL,
        }),
      }),
    );
  }

  return state;
}

const UNREACHABLE: ReportedIssue = {
  type: "UNREACHABLE_ELEMENT",
  severity: "HIGH",
  title: "Add tabindex or use a button element",
  description: "Filter is a div with role=button and no tabindex.",
};

/** The same trace, with one confirmed finding put through the validator. */
function traceWithConfirmedFinding(): AgentState {
  const state = trace();

  const result = new FindingValidator(state).validate({
    issue: UNREACHABLE,
    reason: "Tab traversal reached Logo, Search and Menu but never Filter.",
    confidence: 0.9,
    step: 2,
  });

  if (result.outcome !== "CONFIRMED") {
    throw new Error(
      `fixture expected a confirmable finding: ${result.problems.map((p) => p.reason).join(", ")}`,
    );
  }

  return { ...state, confirmedFindings: [result.finding] };
}

function input(state: AgentState): ReportInput {
  return {
    state,
    startedAt: at(0),
    completedAt: at(30),
    terminationReason: "AGENT_STOPPED",
    method: {
      provider: "openai",
      model: "gpt-4o",
      multimodal: true,
      promptVersion: "1.0.0",
    },
  };
}

const generate = (state: AgentState = traceWithConfirmedFinding()) =>
  new ReportGenerator(input(state)).generate();

describe("the report as a whole", () => {
  it("validates against its own schema", () => {
    expect(() => KeyboardAccessibilityReportSchema.parse(generate())).not.toThrow();
  });

  it("round-trips through JSON", () => {
    const report = generate();
    const parsed = KeyboardAccessibilityReportSchema.parse(
      JSON.parse(JSON.stringify(report)),
    );

    expect(parsed).toEqual(report);
  });

  it("carries a version, so a stored report stays readable", () => {
    expect(generate().reportVersion).toBe("1.0.0");
  });
});

describe("1. Overview", () => {
  it("reports what was audited and how far it got", () => {
    const overview = generate().overview;

    expect(overview.url).toBe(TEST_URL);
    expect(overview.durationMs).toBe(30_000);
    expect(overview.stepsExecuted).toBe(2);
    expect(overview.interactiveElementsDiscovered).toBe(4);
    expect(overview.elementsReached).toBe(3);
    expect(overview.elementsNotReached).toBe(1);
    expect(overview.confirmedIssueCount).toBe(1);
    expect(overview.potentialIssueCount).toBe(0);
  });

  // A truncated run's coverage should be read differently from a complete one.
  it("says why the run ended", () => {
    expect(generate().overview.terminationReason).toBe("AGENT_STOPPED");
  });

  // Findings are only comparable to another run's when these match.
  it("records how the audit was produced", () => {
    expect(generate().overview.method).toEqual({
      provider: "openai",
      model: "gpt-4o",
      multimodal: true,
      promptVersion: "1.0.0",
    });
  });
});

describe("2. Keyboard navigation map", () => {
  it("represents the observed graph", () => {
    const map = generate().navigationMap;

    expect(map.nodes.map((node) => node.label)).toEqual(["Logo", "Search", "Menu"]);
    expect(map.edges).toHaveLength(2);
    expect(map.edges[0]?.actionLabel).toBe("Tab");
  });

  it("names the controls the traversal never reached", () => {
    expect(generate().navigationMap.unreachedElements).toEqual([
      { elementId: "filter", label: "Filter" },
    ]);
  });

  it("reports no cycles in a linear traversal", () => {
    expect(generate().navigationMap.cycles).toEqual([]);
  });
});

describe("3. Exact keyboard journey", () => {
  // The shape from the brief: "1. Tab → Logo".
  it("numbers every keypress and says where focus landed", () => {
    const journey = generate().keyboardJourney;

    expect(
      journey.steps.map(
        (step) => `${step.ordinal}. ${step.actionLabel} → ${step.landedOn}`,
      ),
    ).toEqual(["1. Tab → Search", "2. Tab → Menu"]);
  });

  it("says where the journey started", () => {
    expect(generate().keyboardJourney.startedFrom).toBe("Logo");
  });

  it("gives the bare sequence for pasting into a bug report", () => {
    expect(generate().keyboardJourney.sequence).toEqual(["Tab", "Tab"]);
  });

  it("writes SHIFT_TAB as Shift+Tab", () => {
    let state = traceWithConfirmedFinding();
    state = applyObservation(
      state,
      makeObservation(3, { focus: focusOn(SEARCH), interactiveElements: ALL }),
    );
    state = applyTransition(state, {
      from: focusOn(MENU),
      to: focusOn(SEARCH),
      action: "SHIFT_TAB",
      step: 2,
      at: at(2),
    });
    state = appendStep(
      state,
      makeStep(2, "SHIFT_TAB", {
        observation: makeObservation(2, {
          focus: focusOn(MENU),
          interactiveElements: ALL,
        }),
      }),
    );

    expect(generate(state).keyboardJourney.sequence).toEqual(["Tab", "Tab", "Shift+Tab"]);
  });

  // A step whose keypress was rejected never happened, so it is not a journey
  // step — the journey has to be replayable exactly as written.
  it("omits steps that pressed nothing", () => {
    let state = traceWithConfirmedFinding();
    state = appendStep(state, makeStep(2, null));

    expect(generate(state).keyboardJourney.steps).toHaveLength(2);
  });
});

describe("4. Findings", () => {
  it("reports a confirmed issue with every field a reader needs", () => {
    const finding = generate().confirmedIssues[0];

    expect(finding?.standing).toBe("CONFIRMED_ISSUE");
    expect(finding?.type).toBe("UNREACHABLE_ELEMENT");
    expect(finding?.severity).toBe("HIGH");
    expect(finding?.confidence).toBe(0.9);
    expect(finding?.affectedElement?.label).toBe("Filter");
    expect(finding?.affectedElement?.selector).toBe("#filter");
    expect(finding?.expected).toContain("should be able to reach it");
    expect(finding?.actual).toContain("never focused");
    expect(finding?.reproduction.sequence).toEqual(["Tab", "Tab"]);
    expect(finding?.screenshotIds).toHaveLength(3);
    expect(finding?.aiExplanation).toContain("never Filter");
    expect(finding?.likelyCause.length).toBeGreaterThan(0);
    expect(finding?.suggestedFix.length).toBeGreaterThan(0);
  });

  // The "expected" side is only ever a fact about the document. Asserting an
  // intended order the page never declared would be fabrication.
  it("states expectations as facts, not intentions", () => {
    const finding = generate().confirmedIssues[0];

    expect(finding?.expected).toContain("is an interactive control");
    expect(finding?.expected).not.toMatch(/probably|presumably|intended|should have/i);
  });

  it("reports a suspicion as a potential issue, with no evidence attached", () => {
    const state = {
      ...trace(),
      suspectedFindings: [
        {
          id: "s1" as never,
          status: "SUSPECTED" as const,
          details: {
            type: "SUSPICIOUS_FOCUS_ORDER" as const,
            observedOrder: [],
            expectedOrder: [],
          },
          reasoning: "The order looked unusual.",
          confidence: 0.5 as never,
          detectedAtStep: 1,
          detectedAt: at(1),
        },
      ],
    };

    const potential = generate(state).potentialIssues[0];

    expect(potential?.standing).toBe("POTENTIAL_ISSUE");
    expect(potential?.aiExplanation).toBe("The order looked unusual.");
    expect(potential?.notConfirmedBecause.length).toBeGreaterThan(0);
    // The distinction the whole report rests on.
    expect(potential).not.toHaveProperty("reproduction");
    expect(potential).not.toHaveProperty("screenshotIds");
    expect(potential).not.toHaveProperty("severity");
  });
});

describe("5. Evidence", () => {
  it("lists a screenshot per captured step", () => {
    const evidence = generate().evidence;

    expect(evidence.screenshotCount).toBe(3);
    expect(evidence.items[0]?.screenshotPath).toContain(".png");
    expect(evidence.items[0]?.focus).toBe("Logo");
  });

  // Truncation changes what is provable, so it travels with the evidence.
  it("says whether any capture was truncated", () => {
    expect(generate().evidence.anyCaptureTruncated).toBe(false);
  });
});

describe("6. AI analysis", () => {
  it("keeps the model's reasoning in its own section", () => {
    const analysis = generate().aiAnalysis;

    expect(analysis.decisionsMade).toBe(2);
    expect(analysis.reasoningTrail).toHaveLength(2);
    expect(analysis.reasoningTrail[0]?.decision).toBe("CONTINUE");
    expect(analysis.reasoningTrail[0]?.mode).toBe("EXPLORING");
  });

  it("counts investigations by outcome", () => {
    const analysis = generate().aiAnalysis;

    expect(analysis.investigationsOpened).toBe(0);
    expect(analysis.investigationsConfirmed).toBe(0);
    expect(analysis.investigationsAbandoned).toBe(0);
  });
});

describe("7. Suggested fixes", () => {
  it("proposes a fix per confirmed issue", () => {
    const fixes = generate().suggestedFixes;

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.severity).toBe("HIGH");
    expect(fixes[0]?.affectedElementLabel).toBe("Filter");
  });

  // Advice about a problem nobody established is noise.
  it("proposes nothing for a merely potential issue", () => {
    const state = {
      ...trace(),
      suspectedFindings: [
        {
          id: "s1" as never,
          status: "SUSPECTED" as const,
          details: {
            type: "SUSPICIOUS_FOCUS_CYCLE" as const,
            cycleElementIds: [],
            excludedElementIds: [],
          },
          reasoning: "Might be a loop.",
          confidence: 0.4 as never,
          detectedAtStep: 1,
          detectedAt: at(1),
        },
      ],
    };

    expect(generate(state).suggestedFixes).toEqual([]);
  });
});

describe("what the report refuses to say", () => {
  // A number out of a hundred invites comparison between pages explored to
  // different depths, and implies a completeness this tool does not have.
  it("contains no accessibility score", () => {
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        keys.add(key.toLowerCase());
        walk(nested);
      }
    };
    walk(generate());

    // Checked as field names rather than as text: the limitations section
    // legitimately contains the sentence "There is no score."
    for (const forbidden of ["score", "grade", "rating", "percentage", "outof"]) {
      expect([...keys]).not.toContain(forbidden);
    }
  });

  it("makes no conformance claim", () => {
    const serialized = JSON.stringify(generate()).toLowerCase();

    // WCAG appears only where the report disclaims it.
    expect(serialized).not.toMatch(/wcag\s*2\.\d/);
    expect(serialized).not.toContain("compliant");
    expect(serialized).not.toContain("conformance level");
    expect(serialized).not.toMatch(/level a{1,3}\b/);
  });

  // Stated in the data, so no surface can imply a verdict by omission.
  it("states its limitations in the report itself", () => {
    const limitations = generate().limitations.join(" ").toLowerCase();

    expect(limitations).toContain("no claim about wcag conformance");
    expect(limitations).toContain("there is no score");
    expect(limitations).toContain("tab and shift+tab");
    expect(limitations).toContain("absence of a finding is not evidence of absence");
  });

  it("uses the agreed language for standing", () => {
    const report = generate();

    expect(report.confirmedIssues[0]?.standing).toBe("CONFIRMED_ISSUE");
    expect(JSON.stringify(report)).toContain("confidence");
  });
});

describe("the HTML view model", () => {
  it("lists the seven sections in order", () => {
    const view = toHtmlReportViewModel(generate());

    expect(view.sections.map((section) => section.id)).toEqual([
      "overview",
      "navigation-map",
      "keyboard-journey",
      "findings",
      "evidence",
      "ai-analysis",
      "suggested-fixes",
    ]);
  });

  it("gives each section a title and a one-line summary", () => {
    for (const section of toHtmlReportViewModel(generate()).sections) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.summary.length).toBeGreaterThan(10);
    }
  });

  // Marked empty rather than dropped, so a renderer can say "nothing found"
  // instead of silently omitting a section a reader expected.
  it("marks empty sections rather than hiding them", () => {
    const view = toHtmlReportViewModel(generate(trace()));
    const findings = view.sections.find((section) => section.id === "findings");

    expect(findings?.isEmpty).toBe(true);
    expect(view.sections).toHaveLength(7);
  });

  it("carries the whole report, so a renderer needs nothing else", () => {
    const report = generate();

    expect(toHtmlReportViewModel(report).report).toEqual(report);
  });

  it("orders severity worst first", () => {
    expect(toHtmlReportViewModel(generate()).severityOrder).toEqual([
      "CRITICAL",
      "HIGH",
      "MEDIUM",
      "LOW",
    ]);
  });

  it("summarises using the agreed words", () => {
    const view = toHtmlReportViewModel(generate());

    expect(view.subtitle).toContain("confirmed issue");
    expect(view.subtitle).toContain("potential issue");
  });
});
