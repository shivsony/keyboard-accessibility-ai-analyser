import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MockAIProvider,
  mockContinue,
  mockInvestigate,
  mockReport,
  mockStop,
  AIProviderError,
  type AIProvider,
} from "@/lib/ai";
import { activeInvestigation, agentMode } from "@/lib/shared/domain";
import {
  DEFAULT_SESSION_OPTIONS,
  KeyboardExecutor,
  PlaywrightBrowserController,
  type BrowserSessionOptions,
} from "@/lib/browser";
import { ExplorationAgent, type ExplorationOptions } from "@/lib/agent";
import { describePath, traversalPath } from "@/lib/graph";
import {
  auditId,
  checkAgentStateInvariants,
  UrlSchema,
  type Url,
  type Viewport,
} from "@/lib/shared/domain";

import { startFixtureServer, type FixtureServer } from "../../fixtures/server";

/**
 * The exploration loop, end to end.
 *
 * Real Chromium, real keypresses, real focus — and a **mocked AI provider**, so
 * the test asserts on the loop's behaviour rather than on a model's judgement.
 * No network call is made.
 */

let server: FixtureServer;

const VIEWPORT: Viewport = { width: 1024, height: 768, deviceScaleFactor: 1 };
const AUDIT_ID = auditId("audit-loop-test");

function sessionOptions(): BrowserSessionOptions {
  return {
    ...DEFAULT_SESSION_OPTIONS,
    headless: true,
    viewport: VIEWPORT,
    signal: null,
  };
}

function explorationOptions(
  overrides: Partial<ExplorationOptions> = {},
): ExplorationOptions {
  return {
    maxSteps: 20,
    maxDurationMs: 120_000,
    repeatedStateThreshold: 6,
    maxInvestigationSteps: 12,
    ...overrides,
  };
}

function url(page: string): Url {
  return UrlSchema.parse(server.url(page));
}

/** Runs the loop against a fixture page with a scripted provider. */
async function explore(
  page: string,
  provider: AIProvider,
  options: Partial<ExplorationOptions> = {},
) {
  const browser = new PlaywrightBrowserController(sessionOptions());

  try {
    const controller = await browser.open(url(page));
    const agent = new ExplorationAgent(
      {
        page: controller,
        executor: new KeyboardExecutor(controller, { settleMs: 20 }),
        provider,
      },
      explorationOptions(options),
    );

    return await agent.run({ auditId: AUDIT_ID, url: url(page) });
  } finally {
    await browser.close();
  }
}

beforeAll(async () => {
  server = await startFixtureServer();
}, 30_000);

afterAll(async () => {
  await server.close();
});

describe("the scripted traversal: TAB TAB TAB SHIFT_TAB STOP", () => {
  // well-behaved.html has three controls in reading order:
  //   button "First" → link "Second" → input "Third field"
  const SCRIPT = [
    mockContinue("TAB"),
    mockContinue("TAB"),
    mockContinue("TAB"),
    mockContinue("SHIFT_TAB"),
    mockStop(),
  ];

  it("executes every scripted action and stops when told", async () => {
    const provider = new MockAIProvider({ script: SCRIPT });
    const result = await explore("well-behaved.html", provider);

    expect(result.terminationReason).toBe("AGENT_STOPPED");
    expect(result.error).toBeNull();

    // Five decisions asked for, five steps recorded — including the STOP, which
    // is a step that happened even though it pressed nothing.
    expect(provider.callCount).toBe(5);
    expect(result.state.steps).toHaveLength(5);
    expect(result.state.currentStep).toBe(5);
  }, 60_000);

  it("records the exact keyboard sequence", async () => {
    const result = await explore(
      "well-behaved.html",
      new MockAIProvider({ script: SCRIPT }),
    );

    expect(result.state.keyboardHistory.map((record) => record.action)).toEqual([
      "TAB",
      "TAB",
      "TAB",
      "SHIFT_TAB",
    ]);
    // STOP presses nothing, so it appears in the steps but not the history.
    expect(result.state.keyboardHistory).toHaveLength(4);
  }, 60_000);

  it("records every step with its decision, verdict, and what executed", async () => {
    const result = await explore(
      "well-behaved.html",
      new MockAIProvider({ script: SCRIPT }),
    );

    const steps = result.state.steps;

    expect(steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
    expect(steps.map((step) => step.decision.decision)).toEqual([
      "CONTINUE",
      "CONTINUE",
      "CONTINUE",
      "CONTINUE",
      "STOP",
    ]);
    expect(steps.map((step) => step.executedAction)).toEqual([
      "TAB",
      "TAB",
      "TAB",
      "SHIFT_TAB",
      null,
    ]);
    expect(steps.map((step) => step.guardVerdict.outcome)).toEqual([
      "APPROVED",
      "APPROVED",
      "APPROVED",
      "APPROVED",
      "NO_ACTION",
    ]);

    for (const step of steps) {
      expect(Date.parse(step.startedAt)).not.toBeNaN();
      expect(Date.parse(step.completedAt)).not.toBeNaN();
      expect(step.observation.step).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  // The state transition history: three Tabs forward, one Shift+Tab back.
  it("walks focus forward and back through the real page", async () => {
    const result = await explore(
      "well-behaved.html",
      new MockAIProvider({ script: SCRIPT }),
    );

    const path = traversalPath(result.state.navigationGraph);

    expect(path.actions).toEqual(["TAB", "TAB", "TAB", "SHIFT_TAB"]);
    expect(path.nodes.map((node) => node.accessibleName)).toEqual([
      null, // the document body, before anything was pressed
      "First",
      "Second",
      "Third field",
      "Second",
    ]);
    expect(describePath(path)).toContain("First --TAB--> Second");
  }, 60_000);

  it("ends focused where the last action left it", async () => {
    const result = await explore(
      "well-behaved.html",
      new MockAIProvider({ script: SCRIPT }),
    );

    expect(result.state.currentFocus.kind).toBe("ELEMENT");
    if (result.state.currentFocus.kind === "ELEMENT") {
      expect(result.state.currentFocus.element.accessibleName).toBe("Second");
    }
  }, 60_000);

  it("remembers every control it discovered and which it reached", async () => {
    const result = await explore(
      "well-behaved.html",
      new MockAIProvider({ script: SCRIPT }),
    );

    expect(result.state.discoveredElements).toHaveLength(3);
    // Three distinct controls were focused, even though the fourth press
    // returned to one of them.
    expect(result.state.visitedElementIds).toHaveLength(3);
  }, 60_000);

  it("keeps one observation per step, oldest first", async () => {
    const result = await explore(
      "well-behaved.html",
      new MockAIProvider({ script: SCRIPT }),
    );

    const steps = result.state.previousObservations.map(
      (observation) => observation.step,
    );

    // Ascending, with no gaps introduced by the loop.
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(result.state.currentObservation).not.toBeNull();
  }, 60_000);

  it("captures a screenshot for every observation", async () => {
    const result = await explore(
      "well-behaved.html",
      new MockAIProvider({ script: SCRIPT }),
    );

    // Step 0 plus one per executed action.
    expect(result.state.screenshots).toHaveLength(5);
    expect(new Set(result.state.screenshots.map((shot) => shot.id)).size).toBe(5);
  }, 60_000);

  // If the loop broke its own memory model, any finding built from this state
  // would be unreproducible.
  it("leaves the state coherent", async () => {
    const result = await explore(
      "well-behaved.html",
      new MockAIProvider({ script: SCRIPT }),
    );

    expect(checkAgentStateInvariants(result.state)).toEqual([]);
    expect(result.state.status).toEqual({
      kind: "STOPPED",
      reason: "AGENT_STOPPED",
    });
  }, 60_000);

  it("shows the AI the history it has accumulated", async () => {
    const provider = new MockAIProvider({ script: SCRIPT });
    await explore("well-behaved.html", provider);

    const [first, , , fourth] = provider.received;

    expect(first?.step).toBe(0);
    expect(first?.keyboardHistory).toHaveLength(0);
    expect(first?.previousObservations).toHaveLength(0);

    expect(fourth?.step).toBe(3);
    expect(fourth?.keyboardHistory.map((record) => record.action)).toEqual([
      "TAB",
      "TAB",
      "TAB",
    ]);
    expect(fourth?.navigationSummary).toContain("--TAB-->");
    expect(fourth?.stepsRemaining).toBe(17);
  }, 60_000);
});

describe("stop conditions", () => {
  // The backstop that makes an infinite loop impossible.
  it("stops at the step budget when the AI never does", async () => {
    const provider = new MockAIProvider({
      respond: () => mockContinue("TAB"),
    });

    const result = await explore("well-behaved.html", provider, { maxSteps: 4 });

    expect(result.terminationReason).toBe("STEP_BUDGET_EXHAUSTED");
    expect(result.state.steps).toHaveLength(4);
    expect(provider.callCount).toBe(4);
  }, 60_000);

  it("stops when the wall-clock budget runs out", async () => {
    const provider = new MockAIProvider({ respond: () => mockContinue("TAB") });

    // A clock that jumps a minute per reading exhausts the budget immediately.
    let ticks = 0;
    const result = await explore("well-behaved.html", provider, {
      maxDurationMs: 1_000,
      now: () => {
        ticks += 1;
        return ticks * 60_000;
      },
    });

    expect(result.terminationReason).toBe("TIME_BUDGET_EXHAUSTED");
  }, 60_000);

  // A page that swallows Tab answers every keypress identically. Without the
  // threshold the agent would spend the entire budget learning nothing.
  it("stops when the same state keeps coming back", async () => {
    const provider = new MockAIProvider({ respond: () => mockContinue("TAB") });

    const result = await explore("immobile-focus.html", provider, {
      maxSteps: 50,
      repeatedStateThreshold: 3,
    });

    expect(result.terminationReason).toBe("REPEATED_STATE");
    expect(result.state.steps.length).toBeLessThan(50);
  }, 60_000);

  it("stops when the AI reports and nothing is left to investigate", async () => {
    // Reach all three controls, then report. Every control has been visited and
    // no hypothesis is open, so the investigation is over.
    const provider = new MockAIProvider({
      script: [
        mockContinue("TAB"),
        mockContinue("TAB"),
        mockContinue("TAB"),
        mockReport("SUSPICIOUS_FOCUS_ORDER"),
      ],
    });

    const result = await explore("well-behaved.html", provider);

    expect(result.terminationReason).toBe("INVESTIGATION_COMPLETE");
    expect(result.state.suspectedFindings).toHaveLength(1);
  }, 60_000);

  // Reporting the first problem must not end a run that still has ground to
  // cover — a page can have several.
  it("keeps going after a report while controls remain unreached", async () => {
    const provider = new MockAIProvider({
      script: [mockReport("UNREACHABLE_ELEMENT"), mockContinue("TAB"), mockStop()],
    });

    const result = await explore("unreachable-control.html", provider);

    expect(result.terminationReason).toBe("AGENT_STOPPED");
    expect(result.state.steps).toHaveLength(3);
  }, 60_000);

  it("stops when the AI provider fails", async () => {
    const provider: AIProvider = {
      name: "failing",
      model: "failing",
      multimodal: true,
      analyzeObservation: async () => {
        throw new AIProviderError("REQUEST_FAILED", "provider unreachable");
      },
    };

    const result = await explore("well-behaved.html", provider);

    expect(result.terminationReason).toBe("AI_ERROR");
    expect(result.state.status.kind).toBe("FAILED");
    expect(result.error?.message).toContain("provider unreachable");
  }, 60_000);

  it("stops when the AI cannot produce a valid decision", async () => {
    const provider: AIProvider = {
      name: "invalid",
      model: "invalid",
      multimodal: true,
      analyzeObservation: async () => {
        throw new AIProviderError("INVALID_RESPONSE", "no valid decision");
      },
    };

    const result = await explore("well-behaved.html", provider);

    expect(result.terminationReason).toBe("DECISION_INVALID");
  }, 60_000);

  // A provider is an interface; the loop does not assume every implementation
  // validates its own output.
  it("rejects a decision that never passed the schema", async () => {
    const provider: AIProvider = {
      name: "rogue",
      model: "rogue",
      multimodal: true,
      analyzeObservation: async () =>
        ({
          decision: "CONTINUE",
          action: "ENTER",
          reason: "Press Enter to submit.",
          confidence: 0.9,
        }) as never,
    };

    const result = await explore("well-behaved.html", provider);

    expect(result.terminationReason).toBe("DECISION_INVALID");

    // The rogue action was recorded as rejected, and nothing was pressed.
    const step = result.state.steps.at(-1);
    expect(step?.guardVerdict.outcome).toBe("REJECTED");
    expect(step?.executedAction).toBeNull();
    expect(result.state.keyboardHistory).toHaveLength(0);
  }, 60_000);

  it("stops when the browser goes away mid-run", async () => {
    const browser = new PlaywrightBrowserController(sessionOptions());
    const controller = await browser.open(url("well-behaved.html"));

    const provider = new MockAIProvider({
      respond: () => mockContinue("TAB"),
    });

    const agent = new ExplorationAgent(
      {
        page: controller,
        executor: new KeyboardExecutor(controller, { settleMs: 20 }),
        provider,
      },
      explorationOptions({ maxSteps: 50 }),
    );

    // Closing the browser under the agent is the crash case it must survive.
    setTimeout(() => void browser.close(), 300);

    const result = await agent.run({
      auditId: AUDIT_ID,
      url: url("well-behaved.html"),
    });

    expect(result.terminationReason).toBe("DRIVER_ERROR");
    expect(result.state.status.kind).toBe("FAILED");

    await browser.close();
  }, 60_000);

  it("stops when the audit is cancelled", async () => {
    const controller = new AbortController();
    const provider = new MockAIProvider({
      respond: () => mockContinue("TAB"),
      latencyMs: 20,
    });

    setTimeout(() => controller.abort(), 200);

    const result = await explore("well-behaved.html", provider, {
      maxSteps: 200,
      signal: controller.signal,
    });

    expect(result.terminationReason).toBe("CANCELLED");
  }, 60_000);
});

describe("multimodal input", () => {
  // The loop's job here: real screenshot bytes, from the real browser, reaching
  // the provider on every step. A run whose model never saw the page would look
  // identical from the outside.
  it("sends a real screenshot with every decision", async () => {
    const provider = new MockAIProvider({
      script: [mockContinue("TAB"), mockContinue("TAB"), mockStop()],
    });

    const result = await explore("well-behaved.html", provider);

    expect(provider.callCount).toBe(3);
    expect(provider.screenshotsReceived).toBe(3);
    expect(result.terminationReason).toBe("AGENT_STOPPED");
  }, 60_000);

  it("sends PNG bytes, not a placeholder", async () => {
    const provider = new MockAIProvider({ script: [mockStop()] });

    await explore("well-behaved.html", provider);

    const screenshot = provider.received[0]?.screenshot;

    expect(screenshot).not.toBeNull();
    expect([...(screenshot ?? []).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((screenshot ?? []).length).toBeGreaterThan(1_000);
  }, 60_000);

  // Each step must carry the screenshot of the state it is deciding from, not
  // a stale one from earlier in the run.
  it("sends a fresh screenshot as the page changes", async () => {
    const provider = new MockAIProvider({
      script: [mockContinue("TAB"), mockContinue("TAB"), mockStop()],
    });

    await explore("well-behaved.html", provider);

    const shots = provider.received.map((input) => input.screenshot);

    expect(shots).toHaveLength(3);
    // Focus rings differ between steps, so identical bytes would mean the
    // screenshot was captured once and reused.
    expect(Buffer.from(shots[0] ?? [])).not.toEqual(Buffer.from(shots[1] ?? []));
  }, 60_000);
});

describe("hypotheses", () => {
  it("carries a suspicion forward into later prompts", async () => {
    const provider = new MockAIProvider({
      script: [
        mockInvestigate("SUSPICIOUS_FOCUS_ORDER", "TAB"),
        mockContinue("TAB"),
        mockStop(),
      ],
    });

    const result = await explore("tabindex-jumble.html", provider);

    expect(result.state.suspectedFindings).toHaveLength(1);
    expect(result.state.suspectedFindings[0]?.details.type).toBe(
      "SUSPICIOUS_FOCUS_ORDER",
    );

    // The second prompt shows the hypothesis raised by the first.
    expect(provider.received[1]?.suspectedFindings).toHaveLength(1);
  }, 60_000);

  // A report on step 0 has no keyboard sequence behind it, so there is nothing
  // to reproduce and the validator rejects it.
  it("never confirms a finding on the model's word alone", async () => {
    const provider = new MockAIProvider({
      script: [mockReport("UNREACHABLE_ELEMENT"), mockStop()],
    });

    const result = await explore("unreachable-control.html", provider);

    expect(result.state.suspectedFindings.length).toBeGreaterThan(0);
    expect(result.state.confirmedFindings).toEqual([]);
  }, 60_000);

  // The other half of the rule: a report the trace *does* support is published.
  it("confirms a report the traversal corroborates", async () => {
    const provider = new MockAIProvider({
      script: [
        mockContinue("TAB"),
        mockContinue("TAB"),
        mockContinue("TAB"),
        mockReport("UNREACHABLE_ELEMENT"),
        mockStop(),
      ],
    });

    const result = await explore("skipped-controls.html", provider);
    const confirmed = result.state.confirmedFindings[0];

    expect(result.state.confirmedFindings).toHaveLength(1);
    expect(confirmed?.details.type).toBe("UNREACHABLE_ELEMENT");
    // Every fact in the evidence came from the recording.
    expect(confirmed?.evidence.keyboardSequence).toEqual(["TAB", "TAB", "TAB"]);
    expect(confirmed?.evidence.screenshotIds.length).toBeGreaterThan(0);
    expect(checkAgentStateInvariants(result.state)).toEqual([]);
  }, 60_000);

  // The model reports a problem the page does not have. Nothing is published.
  it("rejects a report the traversal contradicts", async () => {
    const provider = new MockAIProvider({
      script: [
        mockContinue("TAB"),
        mockContinue("TAB"),
        mockContinue("TAB"),
        // well-behaved.html reaches every control, so there is nothing
        // unreachable for this claim to be about.
        mockReport("UNREACHABLE_ELEMENT"),
        mockStop(),
      ],
    });

    const result = await explore("well-behaved.html", provider);

    expect(result.state.confirmedFindings).toEqual([]);
    // The suspicion stays on the record; only the report was refused.
    expect(result.state.suspectedFindings.length).toBeGreaterThan(0);
  }, 60_000);

  it("does not confirm the same finding twice", async () => {
    const provider = new MockAIProvider({
      script: [
        mockContinue("TAB"),
        mockContinue("TAB"),
        mockContinue("TAB"),
        mockReport("UNREACHABLE_ELEMENT"),
        mockContinue("TAB"),
        mockReport("UNREACHABLE_ELEMENT"),
        mockStop(),
      ],
    });

    const result = await explore("skipped-controls.html", provider);

    expect(result.state.confirmedFindings).toHaveLength(1);
  }, 60_000);

  it("does not raise the same hypothesis twice", async () => {
    const provider = new MockAIProvider({
      script: [
        mockInvestigate("SUSPICIOUS_FOCUS_CYCLE", "TAB"),
        mockInvestigate("SUSPICIOUS_FOCUS_CYCLE", "TAB"),
        mockStop(),
      ],
    });

    const result = await explore("focus-trap.html", provider);

    expect(result.state.suspectedFindings).toHaveLength(1);
  }, 60_000);
});

describe("investigation", () => {
  /**
   * skipped-controls.html is the worked example: Logo, Menu, Search, Filter and
   * Checkout are all discoverable, but Tab reaches only Logo, Search and
   * Checkout. Menu and Filter are divs with role=button and no tabindex.
   */

  it("discovers controls the traversal cannot reach", async () => {
    const provider = new MockAIProvider({
      script: [mockContinue("TAB"), mockContinue("TAB"), mockContinue("TAB"), mockStop()],
    });

    const result = await explore("skipped-controls.html", provider);
    const reached = new Set(result.state.visitedElementIds);
    const missed = result.state.discoveredElements.filter(
      (element) => !reached.has(element.id),
    );

    expect(result.state.discoveredElements).toHaveLength(5);
    expect(missed.map((element) => element.accessibleName).sort()).toEqual([
      "Filter",
      "Menu",
    ]);
  }, 60_000);

  // The suspicion is visible in the input the model receives, which is what
  // lets it notice the gap in the first place.
  it("shows the model which controls were skipped", async () => {
    const provider = new MockAIProvider({
      script: [mockContinue("TAB"), mockContinue("TAB"), mockStop()],
    });

    await explore("skipped-controls.html", provider);

    const last = provider.received.at(-1);
    const reached = new Set(last?.visitedElementIds ?? []);

    expect(
      (last?.discoveredElements ?? []).filter((element) => !reached.has(element.id)),
    ).not.toHaveLength(0);
  }, 60_000);

  it("switches into investigating mode and records it per step", async () => {
    const provider = new MockAIProvider({
      script: [
        mockContinue("TAB"),
        mockContinue("TAB"),
        mockInvestigate("UNREACHABLE_ELEMENT", "SHIFT_TAB"),
        mockStop(),
      ],
    });

    const result = await explore("skipped-controls.html", provider);

    expect(result.state.steps.map((step) => step.mode)).toEqual([
      "EXPLORING",
      "EXPLORING",
      "EXPLORING", // the step that *decided* to investigate was still exploring
      "INVESTIGATING", // the next step ran while the enquiry was open
    ]);
  }, 60_000);

  it("accumulates evidence across several investigating steps", async () => {
    const provider = new MockAIProvider({
      script: [
        mockContinue("TAB"),
        mockInvestigate("UNREACHABLE_ELEMENT", "SHIFT_TAB"),
        mockInvestigate("UNREACHABLE_ELEMENT", "SHIFT_TAB"),
        mockInvestigate("UNREACHABLE_ELEMENT", "TAB"),
        mockStop(),
      ],
    });

    const result = await explore("skipped-controls.html", provider);
    const investigation = result.state.investigations[0];

    expect(result.state.investigations).toHaveLength(1);
    expect(investigation?.evidenceActions).toEqual(["SHIFT_TAB", "SHIFT_TAB", "TAB"]);
    expect(investigation?.attemptedActions.map((record) => record.step)).toEqual([
      1, 2, 3,
    ]);
    expect(investigation?.suspiciousElementIds.length).toBeGreaterThan(0);
  }, 60_000);

  it("tells the model it is investigating, with the evidence so far", async () => {
    const provider = new MockAIProvider({
      script: [
        mockInvestigate("UNREACHABLE_ELEMENT", "TAB"),
        mockInvestigate("UNREACHABLE_ELEMENT", "TAB"),
        mockStop(),
      ],
    });

    await explore("skipped-controls.html", provider);

    // The first request had no open enquiry; the second was mid-investigation.
    expect(provider.received[0]?.investigation).toBeNull();
    expect(provider.received[1]?.investigation).not.toBeNull();
    expect(provider.received[1]?.investigation?.issueType).toBe("UNREACHABLE_ELEMENT");
    expect(provider.received[1]?.investigation?.evidenceActions).toEqual(["TAB"]);
  }, 60_000);

  it("confirms the investigation when the agent reports", async () => {
    const provider = new MockAIProvider({
      script: [
        mockContinue("TAB"),
        mockInvestigate("UNREACHABLE_ELEMENT", "SHIFT_TAB"),
        mockInvestigate("UNREACHABLE_ELEMENT", "TAB"),
        mockReport("UNREACHABLE_ELEMENT"),
        mockStop(),
      ],
    });

    const result = await explore("skipped-controls.html", provider);
    const investigation = result.state.investigations[0];

    expect(investigation?.status).toBe("CONFIRMED");
    expect(investigation?.closedAt).not.toBeNull();
    expect(investigation?.evidenceActions).toEqual(["SHIFT_TAB", "TAB"]);
    expect(agentMode(result.state)).toBe("EXPLORING");
  }, 60_000);

  // Dropping a suspicion that did not bear out is what resuming ordinary
  // exploration looks like from outside.
  it("abandons the enquiry when the agent goes back to exploring", async () => {
    const provider = new MockAIProvider({
      script: [
        mockInvestigate("UNREACHABLE_ELEMENT", "SHIFT_TAB"),
        mockContinue("TAB"),
        mockStop(),
      ],
    });

    const result = await explore("skipped-controls.html", provider);
    const investigation = result.state.investigations[0];

    expect(investigation?.status).toBe("ABANDONED");
    expect(investigation?.abandonReason).toBe("AGENT_MOVED_ON");
    expect(activeInvestigation(result.state)).toBeNull();
  }, 60_000);

  it("keeps an abandoned enquiry on the record", async () => {
    const provider = new MockAIProvider({
      script: [
        mockInvestigate("SUSPICIOUS_FOCUS_ORDER", "SHIFT_TAB"),
        mockContinue("TAB"),
        mockStop(),
      ],
    });

    const result = await explore("skipped-controls.html", provider);

    expect(result.state.investigations).toHaveLength(1);
    expect(result.state.investigations[0]?.hypotheses.length).toBeGreaterThan(0);
  }, 60_000);

  // Two questions at once means neither has a clean evidence path.
  it("closes the current enquiry before opening one about something else", async () => {
    const provider = new MockAIProvider({
      script: [
        mockInvestigate("UNREACHABLE_ELEMENT", "TAB"),
        mockInvestigate("SUSPICIOUS_FOCUS_ORDER", "TAB"),
        mockStop(),
      ],
    });

    const result = await explore("skipped-controls.html", provider);

    expect(result.state.investigations).toHaveLength(2);
    expect(result.state.investigations[0]?.status).toBe("ABANDONED");
    expect(result.state.investigations[1]?.issueType).toBe("SUSPICIOUS_FOCUS_ORDER");
  }, 60_000);

  // A line of enquiry must not quietly consume the whole run.
  it("abandons an investigation that outstays its budget", async () => {
    const provider = new MockAIProvider({
      respond: () => mockInvestigate("UNREACHABLE_ELEMENT", "TAB"),
    });

    const result = await explore("skipped-controls.html", provider, {
      maxSteps: 12,
      maxInvestigationSteps: 3,
    });

    const abandoned = result.state.investigations.filter(
      (investigation) => investigation.abandonReason === "BUDGET_EXHAUSTED",
    );

    expect(abandoned.length).toBeGreaterThan(0);
    expect(abandoned[0]?.attemptedActions).toHaveLength(3);
  }, 60_000);

  // Investigating is still exploring with the keyboard: every keypress an
  // enquiry makes goes through the same guard as any other.
  it("does not let investigation bypass the action guard", async () => {
    const rogue: AIProvider = {
      name: "rogue-investigator",
      model: "rogue",
      multimodal: true,
      analyzeObservation: async () =>
        ({
          decision: "INVESTIGATE",
          action: "ENTER",
          reason: "Activate the menu to see whether it is reachable.",
          confidence: 0.9,
          suspectedIssue: { type: "UNREACHABLE_ELEMENT", severity: "HIGH" },
        }) as never,
    };

    const result = await explore("skipped-controls.html", rogue);

    expect(result.terminationReason).toBe("DECISION_INVALID");
    expect(result.state.steps.at(-1)?.guardVerdict.outcome).toBe("REJECTED");
    expect(result.state.keyboardHistory).toHaveLength(0);
    // Nothing was investigated, because nothing was executed.
    expect(result.state.investigations).toEqual([]);
  }, 60_000);

  it("keeps the state coherent throughout an investigation", async () => {
    const provider = new MockAIProvider({
      script: [
        mockContinue("TAB"),
        mockInvestigate("UNREACHABLE_ELEMENT", "SHIFT_TAB"),
        mockInvestigate("UNREACHABLE_ELEMENT", "TAB"),
        mockReport("UNREACHABLE_ELEMENT"),
        mockContinue("TAB"),
        mockStop(),
      ],
    });

    const result = await explore("skipped-controls.html", provider);

    expect(checkAgentStateInvariants(result.state)).toEqual([]);
  }, 60_000);
});
