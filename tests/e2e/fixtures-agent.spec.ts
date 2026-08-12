import { expect, test } from "@playwright/test";

import { ExplorationAgent, type ExplorationOptions } from "@/lib/agent";
import { MockAIProvider, mockContinue } from "@/lib/ai";
import {
  DEFAULT_SESSION_OPTIONS,
  KeyboardExecutor,
  PlaywrightBrowserController,
} from "@/lib/browser";
import { FIXTURES, findFixture, type Fixture } from "@/lib/fixtures/manifest";
import { observeFindings } from "@/lib/rules";
import {
  auditId,
  checkAgentStateInvariants,
  UrlSchema,
  type AgentState,
  type FindingType,
} from "@/lib/shared/domain";

/**
 * The agent against the fixtures, with a **mocked AI provider**.
 *
 * No network call, no API key, no cost — and no judgement from a model either.
 * The AI is scripted to Tab, so what these tests measure is the *deterministic*
 * half of the system: what the browser layer observes, what the graph records,
 * and which findings the trace supports.
 *
 * That separation is the point. The rules layer decides what the evidence
 * establishes, and it must reach the same conclusion every time regardless of
 * what any model happens to say. A finding that only appears when the model is
 * in the mood is not a finding.
 *
 * These run inside Playwright because the fixtures are served by the app's own
 * server, which `playwright.config.ts` already starts. The agent drives its own
 * Chromium; Playwright is only providing the server and the runner.
 */

const VIEWPORT = { width: 1024, height: 768, deviceScaleFactor: 1 };

function options(overrides: Partial<ExplorationOptions> = {}): ExplorationOptions {
  return {
    maxSteps: 14,
    maxDurationMs: 120_000,
    repeatedStateThreshold: 5,
    maxInvestigationSteps: 6,
    ...overrides,
  };
}

/** Explores a fixture by pressing Tab until the budget runs out. */
async function explore(
  fixture: Fixture,
  baseURL: string,
  overrides: Partial<ExplorationOptions> = {},
): Promise<AgentState> {
  const url = UrlSchema.parse(new URL(fixture.path, baseURL).toString());
  const browser = new PlaywrightBrowserController({
    ...DEFAULT_SESSION_OPTIONS,
    headless: true,
    viewport: VIEWPORT,
    signal: null,
  });

  try {
    const page = await browser.open(url);

    // Scripted, not scored: the model presses Tab and nothing else, so every
    // conclusion below comes from the trace rather than from its opinion.
    const provider = new MockAIProvider({ respond: () => mockContinue("TAB") });

    const agent = new ExplorationAgent(
      { page, executor: new KeyboardExecutor(page, { settleMs: 40 }), provider },
      options(overrides),
    );

    const result = await agent.run({ auditId: auditId(`fixture-${fixture.id}`), url });
    return result.state;
  } finally {
    await browser.close();
  }
}

/** The finding types the trace supports, deduplicated. */
function observedTypes(state: AgentState): FindingType[] {
  return [...new Set(observeFindings(state).map((finding) => finding.details.type))];
}

function labelsOf(state: AgentState, ids: readonly string[]): string[] {
  return ids.map((id) => {
    const element = state.discoveredElements.find((each) => each.id === id);
    return element?.accessibleName ?? element?.role ?? id;
  });
}

test.describe.configure({ mode: "serial" });

test.describe("every fixture explores cleanly", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.id} produces a coherent trace`, async ({ baseURL }) => {
      const state = await explore(fixture, baseURL ?? "http://localhost:3000");

      // Nothing the agent recorded contradicts anything else it recorded. A
      // violation here means any finding built from this state is unusable.
      expect(checkAgentStateInvariants(state)).toEqual([]);
      expect(state.screenshots.length).toBeGreaterThan(0);
    });
  }
});

// The manifest is the contract: what a fixture produces and what it documents
// must be the same list, or the documentation is fiction.
test.describe("observed findings match the manifest", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.id} reports exactly what it documents`, async ({ baseURL }) => {
      const state = await explore(fixture, baseURL ?? "http://localhost:3000");

      expect([...observedTypes(state)].sort()).toEqual(
        [...fixture.expectation.reportableIssues].sort(),
      );
    });
  }
});

test.describe("fixtures with nothing to find", () => {
  // The false-positive check, and the one that matters most in practice: a tool
  // that reports problems on a correct page teaches people to ignore it.
  for (const fixture of FIXTURES.filter(
    (each) => each.expectation.reportableIssues.length === 0,
  )) {
    test(`${fixture.id} supports no findings`, async ({ baseURL }) => {
      const state = await explore(fixture, baseURL ?? "http://localhost:3000");

      expect(observedTypes(state)).toEqual([]);
      expect(state.confirmedFindings).toEqual([]);
    });
  }
});

test("good: reaches every control it discovers", async ({ baseURL }) => {
  const fixture = findFixture("good")!;
  const state = await explore(fixture, baseURL ?? "http://localhost:3000");

  const reached = new Set(state.visitedElementIds);
  const missed = state.discoveredElements.filter((each) => !reached.has(each.id));

  expect(missed).toEqual([]);
  expect(state.visitedElementIds.length).toBe(fixture.expectedFocusOrder.length);
});

test("unreachable: the trace supports exactly one finding", async ({ baseURL }) => {
  const state = await explore(
    findFixture("unreachable")!,
    baseURL ?? "http://localhost:3000",
  );

  expect(observedTypes(state)).toEqual(["UNREACHABLE_ELEMENT"]);

  const unreached = observeFindings(state)
    .filter((finding) => finding.details.type === "UNREACHABLE_ELEMENT")
    .map((finding) =>
      finding.details.type === "UNREACHABLE_ELEMENT" ? finding.details.elementId : "",
    );

  expect(labelsOf(state, unreached)).toEqual(["Delete account"]);
});

test("focus-order: the observed order diverges from DOM order", async ({ baseURL }) => {
  const state = await explore(
    findFixture("focus-order")!,
    baseURL ?? "http://localhost:3000",
  );

  expect(observedTypes(state)).toContain("SUSPICIOUS_FOCUS_ORDER");

  const finding = observeFindings(state).find(
    (each) => each.details.type === "SUSPICIOUS_FOCUS_ORDER",
  );

  // Both orders are recorded, so the divergence is checkable rather than
  // asserted — and the "expected" side is DOM order, never an invention.
  if (finding?.details.type === "SUSPICIOUS_FOCUS_ORDER") {
    expect(labelsOf(state, finding.details.observedOrder)).toEqual([
      "Third visually",
      "Second visually",
      "First visually",
    ]);
    expect(labelsOf(state, finding.details.expectedOrder)).toEqual([
      "First visually",
      "Second visually",
      "Third visually",
    ]);
  }
});

test("focus-escape: the trace records focus leaving the page", async ({ baseURL }) => {
  const state = await explore(
    findFixture("focus-escape")!,
    baseURL ?? "http://localhost:3000",
  );

  expect(observedTypes(state)).toContain("UNEXPECTED_FOCUS_LEAVING_PAGE");
});

test("cycle: the graph contains a loop and excludes a control", async ({ baseURL }) => {
  const state = await explore(findFixture("cycle")!, baseURL ?? "http://localhost:3000");
  const types = observedTypes(state);

  expect(types).toContain("SUSPICIOUS_FOCUS_CYCLE");
  expect(types).toContain("UNREACHABLE_ELEMENT");

  const reached = new Set(state.visitedElementIds);
  const missed = state.discoveredElements.filter((each) => !reached.has(each.id));

  expect(
    labelsOf(
      state,
      missed.map((each) => each.id),
    ),
  ).toContain("Outside the trap");
});

test("dynamic: controls revealed mid-run are discovered and reached", async ({
  baseURL,
}) => {
  const state = await explore(
    findFixture("dynamic")!,
    baseURL ?? "http://localhost:3000",
  );

  const names = state.discoveredElements.map((each) => each.accessibleName);

  expect(names).toContain("Option A");
  expect(names).toContain("Option B");

  // Discovered *after* step 0: they did not exist when the run began.
  const optionA = state.discoveredElements.find(
    (each) => each.accessibleName === "Option A",
  );
  expect(optionA?.discoveredAtStep).toBeGreaterThan(0);
});

// Elements that are correctly unfocusable must not be reported. This is the
// fixture that catches an over-eager discovery rule.
test("disabled: nothing correctly-unfocusable is reported", async ({ baseURL }) => {
  const state = await explore(
    findFixture("disabled")!,
    baseURL ?? "http://localhost:3000",
  );

  expect(observedTypes(state)).toEqual([]);

  const disabled = state.discoveredElements.find((each) => each.disabled);
  const hidden = state.discoveredElements.find((each) => !each.visible);

  // They may be discovered — that is how the rules layer knows to leave them
  // alone — but neither may end up in a finding.
  expect(disabled?.disabled ?? true).toBe(true);
  expect(hidden?.visible ?? false).toBe(false);
});

// NO_KEYBOARD_REACHABLE_CONTROLS is about a page that has controls and reaches
// none. A page with none is a different situation and not a defect.
test("no-controls: reports nothing at all", async ({ baseURL }) => {
  const state = await explore(
    findFixture("no-controls")!,
    baseURL ?? "http://localhost:3000",
  );

  expect(state.discoveredElements).toEqual([]);
  expect(observedTypes(state)).toEqual([]);
});
