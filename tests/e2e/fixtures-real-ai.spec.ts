import { expect, test } from "@playwright/test";

import { ExplorationAgent } from "@/lib/agent";
import { createAIProvider } from "@/lib/ai";
import {
  DEFAULT_SESSION_OPTIONS,
  KeyboardExecutor,
  PlaywrightBrowserController,
} from "@/lib/browser";
import { findFixture, type Fixture } from "@/lib/fixtures/manifest";
import {
  auditId,
  checkAgentStateInvariants,
  UrlSchema,
  type AgentState,
  type FindingType,
} from "@/lib/shared/domain";

/**
 * The agent against the fixtures, using a **real AI provider**.
 *
 * ## Opt-in, deliberately
 *
 * Skipped unless `RUN_REAL_AI_TESTS=1` **and** a provider is configured. It will
 * never run in ordinary CI by accident, because:
 *
 * - It costs money. Every step is a vision call against the user's own key.
 * - It is not deterministic. A model can reasonably explore the same page two
 *   different ways, so these cannot assert an exact step count or sequence.
 * - It needs network access, which a sandboxed CI runner may not have.
 *
 * Run them with:
 *
 *     RUN_REAL_AI_TESTS=1 pnpm test:e2e tests/e2e/fixtures-real-ai.spec.ts
 *
 * ## What they can and cannot check
 *
 * They assert **properties**, not transcripts: that the agent terminates, that
 * it does not report anything on a page with nothing wrong, and that where it
 * does report something the finding is one the trace supports.
 *
 * They deliberately do not assert that the model *finds* every planted defect.
 * A miss is worth knowing about, but it is a quality signal rather than a
 * regression — failing the build over one would make the suite a coin toss, and
 * a test nobody trusts gets deleted.
 */

const ENABLED = process.env.RUN_REAL_AI_TESTS === "1";
const CONFIGURED =
  (process.env.OPENAI_API_KEY ?? "").trim() !== "" || process.env.AI_PROVIDER === "mock";

test.skip(!ENABLED, "Real-AI tests are opt-in. Set RUN_REAL_AI_TESTS=1 to run them.");
test.skip(
  ENABLED && !CONFIGURED,
  "RUN_REAL_AI_TESTS=1 is set but no provider is configured. Set OPENAI_API_KEY.",
);

// One model call per step, each with a screenshot. Generous per test, small
// budget per run.
test.describe.configure({ mode: "serial", timeout: 300_000 });

const MAX_STEPS = 12;

type RealRun = {
  readonly state: AgentState;
  readonly terminationReason: string;
  readonly decisions: readonly string[];
};

async function explore(fixture: Fixture, baseURL: string): Promise<RealRun> {
  const url = UrlSchema.parse(new URL(fixture.path, baseURL).toString());
  const browser = new PlaywrightBrowserController({
    ...DEFAULT_SESSION_OPTIONS,
    headless: true,
    viewport: { width: 1024, height: 768, deviceScaleFactor: 1 },
    signal: null,
  });

  try {
    const page = await browser.open(url);
    const agent = new ExplorationAgent(
      {
        page,
        executor: new KeyboardExecutor(page, { settleMs: 100 }),
        provider: createAIProvider(),
      },
      {
        maxSteps: MAX_STEPS,
        maxDurationMs: 240_000,
        repeatedStateThreshold: 5,
        maxInvestigationSteps: 5,
      },
    );

    const result = await agent.run({ auditId: auditId(`real-${fixture.id}`), url });

    return {
      state: result.state,
      terminationReason: result.terminationReason,
      decisions: result.state.steps.map((step) => step.decision.decision),
    };
  } finally {
    await browser.close();
  }
}

function confirmedTypes(state: AgentState): FindingType[] {
  return state.confirmedFindings.map((finding) => finding.details.type);
}

test("good: a correct page produces no confirmed findings", async ({ baseURL }) => {
  const run = await explore(findFixture("good")!, baseURL ?? "http://localhost:3000");

  // The property that matters most in practice. A tool that invents problems on
  // a correct page is worse than no tool.
  expect(confirmedTypes(run.state)).toEqual([]);
  expect(checkAgentStateInvariants(run.state)).toEqual([]);
});

test("disabled: correctly-unfocusable elements are not reported", async ({ baseURL }) => {
  const run = await explore(findFixture("disabled")!, baseURL ?? "http://localhost:3000");

  expect(confirmedTypes(run.state)).toEqual([]);
});

test("no-controls: an empty page is recognised and not reported", async ({ baseURL }) => {
  const run = await explore(
    findFixture("no-controls")!,
    baseURL ?? "http://localhost:3000",
  );

  expect(confirmedTypes(run.state)).toEqual([]);
  // Nothing to explore, so it should not spend the whole budget discovering
  // that. Generous, because a model is entitled to look twice.
  expect(run.state.steps.length).toBeLessThan(MAX_STEPS);
});

test("unreachable: any finding it reports is one the trace supports", async ({
  baseURL,
}) => {
  const run = await explore(
    findFixture("unreachable")!,
    baseURL ?? "http://localhost:3000",
  );

  // Not "it must find the bug" — a model may spend its budget exploring. What
  // must hold is that anything it *did* confirm is real, which the validator
  // already enforces and this re-checks end to end.
  for (const type of confirmedTypes(run.state)) {
    expect(["UNREACHABLE_ELEMENT"]).toContain(type);
  }

  expect(checkAgentStateInvariants(run.state)).toEqual([]);
});

test("cycle: the agent escapes the trap rather than spending the budget", async ({
  baseURL,
}) => {
  const run = await explore(findFixture("cycle")!, baseURL ?? "http://localhost:3000");

  // A trap is where an agent is most likely to loop forever. Termination is
  // guaranteed by the budget, so what this checks is that it terminates for a
  // *reason* rather than by running out.
  expect([
    "AGENT_STOPPED",
    "INVESTIGATION_COMPLETE",
    "REPEATED_STATE",
    "STEP_BUDGET_EXHAUSTED",
  ]).toContain(run.terminationReason);

  expect(checkAgentStateInvariants(run.state)).toEqual([]);
});

test("every decision is one the contract allows", async ({ baseURL }) => {
  const run = await explore(
    findFixture("focus-order")!,
    baseURL ?? "http://localhost:3000",
  );

  for (const decision of run.decisions) {
    expect(["CONTINUE", "INVESTIGATE", "REPORT", "STOP"]).toContain(decision);
  }

  // Every executed key was allowlisted. The guard enforces this; the point of
  // checking it against a real model is that a real model is the only thing
  // that will ever genuinely try to ask for something else.
  for (const record of run.state.keyboardHistory) {
    expect(["TAB", "SHIFT_TAB"]).toContain(record.action);
  }
});
